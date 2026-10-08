/*
 * Web research backend: bounded public-web retrieval for the web-research
 * capability. Direct HTTP page reads with public-destination validation and
 * connection-time address pinning (original Host header and TLS SNI kept),
 * maintained-parser HTML-to-text extraction (node-html-parser), and optional
 * Exa search.
 * No browser, no JavaScript rendering, no credential forwarding, and no
 * private-network destinations, including through redirects.
 */
import { lookup } from "node:dns/promises";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIPv4, isIPv6 } from "node:net";
import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";
import { parse } from "node-html-parser";
import { WebBackendError, type WebBackend } from "./types.js";

export interface WebBackendConfig {
  /** Exa API key enabling search(); without it only direct URL reads are available. */
  searchApiKey?: string;
  /** DNS and connection/body deadlines (default 20s each), plus a 60s overall redirect-chain cap. */
  requestTimeoutMs?: number;
}

const SEARCH_ENDPOINT = "https://api.exa.ai/search";
const USER_AGENT = "DispatchWeb-WebResearch/0.1";
const ACCEPT = "text/html,application/xhtml+xml,text/plain;q=0.9,application/json;q=0.8,*/*;q=0.5";
const OPEN_TIMEOUT_MS = 20_000;
const OPEN_TOTAL_TIMEOUT_MS = 60_000;
const MAX_REDIRECTS = 5;
const MAX_BODY_BYTES = 5 * 1024 * 1024;
const MAX_SEARCH_BYTES = 2 * 1024 * 1024;
const MAX_TEXT_CHARS = 200_000;
const MAX_LINKS = 250;
const MAX_LINK_TEXT_CHARS = 200;
const MAX_RESULTS = 8;
const MAX_SNIPPET_CHARS = 600;

const BLOCKED_HOST_LABELS = new Set(["localhost"]);
const BLOCKED_HOST_SUFFIXES = [".local", ".internal", ".lan", ".home.arpa", ".in-addr.arpa", ".alt.arpa"];

/** Private, special, or otherwise non-public IPv4; malformed values are blocked. */
function isBlockedIPv4(address: string): boolean {
  const octets = address.split(".");
  if (octets.length !== 4 || octets.some(octet => !/^\d{1,3}$/.test(octet) || Number(octet) > 255)) return true;
  const [a, b] = octets.map(Number);
  // 0/8, 10/8, 100.64/10 CGNAT, loopback, link-local, private, 192.0.0/24 + 192.0.2/24 (TEST-NET),
  // 198.18/15 benchmark, and 224/4+ multicast/reserved/broadcast.
  return a === 0 || a === 10 || (a === 100 && b >= 64 && b <= 127) || a === 127 || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 0) || (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) || a >= 224;
}

/** Expand an IPv6 literal (with :: compression or an embedded IPv4 tail) to 8 groups; null when malformed. */
function expandIPv6(address: string): bigint[] | null {
  const halves = address.split("::");
  if (halves.length > 2) return null;
  const parse = (part: string): bigint[] | null => {
    if (!part) return [];
    const tokens = part.split(":");
    const groups: bigint[] = [];
    for (const [index, token] of tokens.entries()) {
      if (/^[0-9a-fA-F]{1,4}$/.test(token)) { groups.push(BigInt(Number.parseInt(token, 16))); continue; }
      // An embedded IPv4 tail is valid only as the final token and contributes two groups.
      if (index === tokens.length - 1 && isIPv4(token)) {
        const [w, x, y, z] = token.split(".").map(Number);
        groups.push(BigInt(w * 256 + x), BigInt(y * 256 + z));
        continue;
      }
      return null;
    }
    return groups;
  };
  const head = parse(halves[0]);
  if (head === null || halves.length === 1) return head;
  const tail = parse(halves[1]);
  if (tail === null) return null;
  const missing = 8 - head.length - tail.length;
  return missing < 0 ? null : [...head, ...Array.from({ length: missing }, () => 0n), ...tail];
}

/** Private, special, or otherwise non-public IPv6; malformed values are blocked. */
function isBlockedIPv6(address: string): boolean {
  const groups = expandIPv6(address);
  if (!groups || groups.length !== 8) return true;
  const embeddedIPv4 = (high: number, low: number) =>
    `${Number(groups[high] >> 8n)}.${Number(groups[high] & 0xffn)}.${Number(groups[low] >> 8n)}.${Number(groups[low] & 0xffn)}`;
  // IPv4-mapped ::ffff:0:0/96: a private embedded IPv4 is reported precisely; the 0000::/8 block below rejects the rest.
  if (groups.slice(0, 5).every(g => g === 0n) && groups[5] === 0xffffn) return isBlockedIPv4(embeddedIPv4(6, 7));
  // Translation/transition prefixes embed an IPv4 destination; a private embedded IPv4 is a tunnel to a non-public address.
  if (groups[0] === 0x64n && groups[1] === 0xff9bn) {
    if (groups[2] === 1n) return true;                                                       // RFC 8215 local-use NAT64
    if (groups.slice(2, 6).every(g => g === 0n)) return isBlockedIPv4(embeddedIPv4(6, 7));   // RFC 6052 well-known NAT64
  }
  if (groups[0] === 0x2002n) return isBlockedIPv4(embeddedIPv4(1, 2));                       // RFC 3056 6to4
  if (groups[0] === 0x2001n && groups[1] < 0x0200n) return true;                              // 2001::/23 IETF special (Teredo, ORCHID)
  if (groups[0] === 0x100n && groups.slice(1, 4).every(g => g === 0n)) return true;              // 100::/64 discard-only
  // 0000::/8 is reserved in full: ::, loopback ::1, and every other 0-prefixed address.
  if (groups[0] === 0n) return true;
  if ((groups[0] & 0xfe00n) === 0xfc00n) return true;                                          // fc00::/7 unique local
  if ((groups[0] & 0xff00n) === 0xfe00n) return true;                                          // fe00::/8 link/site-local
  if ((groups[0] & 0xff00n) === 0xff00n) return true;                                          // ff00::/8 multicast
  return groups[0] === 0x2001n && groups[1] === 0xdb8n;                                      // 2001:db8::/32 documentation
}

/** A validated public destination plus the pinned address every connection for it must use. */
interface Destination {
  url: URL;
  address: string;
}

/** Resolve under the deadline: lookup() itself has no signal support, so race it against abort. */
async function resolvePublicHost(host: string, signal: AbortSignal): Promise<string> {
  const addresses: { address: string }[] = await Promise.race([
    lookup(host, { all: true }),
    new Promise<never>((_, reject) => {
      if (signal.aborted) { reject(signal.reason); return; }
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }),
  ]);
  if (!Array.isArray(addresses) || addresses.length === 0)
    throw new WebBackendError(`Could not resolve the hostname (${host}).`);
  // Every resolved address must be public, so an attacker-controlled record cannot mix in a private target.
  for (const { address } of addresses)
    if (isIPv4(address) ? isBlockedIPv4(address) : isBlockedIPv6(address))
      throw new WebBackendError("The hostname resolves to a blocked (private or special) address.");
  return addresses[0].address;
}

/** Reject anything that is not a public http(s) destination: scheme, credentials, port, host, and DNS. */
async function assertPublicDestination(input: string, signal: AbortSignal): Promise<Destination> {
  let url: URL;
  try { url = new URL(input); } catch { throw new WebBackendError("Expected a well-formed URL."); }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new WebBackendError("Only http and https URLs are supported.");
  if (url.username || url.password) throw new WebBackendError("URLs with embedded credentials are rejected.");
  const port = url.port === "" ? (url.protocol === "https:" ? 443 : 80) : Number(url.port);
  if (!Number.isInteger(port) || port !== 80 && port !== 443)
    throw new WebBackendError("Only the default ports (http 80, https 443) are allowed for public destinations.");
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (BLOCKED_HOST_LABELS.has(host) || BLOCKED_HOST_SUFFIXES.some(suffix => host.endsWith(suffix)))
    throw new WebBackendError("Private or local hostnames are not supported.");
  if (isIPv6(host)) {
    if (isBlockedIPv6(host)) throw new WebBackendError("Private or special IP addresses are not supported.");
    return { url, address: host };
  }
  if (isIPv4(host)) {
    if (isBlockedIPv4(host)) throw new WebBackendError("Private or special IP addresses are not supported.");
    return { url, address: host };
  }
  // A dotless name could resolve through search domains to an internal host; require a dotted public DNS name.
  if (host.length > 253 || !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host))
    throw new WebBackendError("Expected a public DNS hostname.");
  // The validated address is pinned at connection time, closing the DNS-rebinding window between checks and use.
  return { url, address: await resolvePublicHost(host, signal) };
}

/** Caller cancellation plus a wall-clock cap. */
function deadline(signal: AbortSignal | undefined, ms: number): AbortSignal {
  const signals: AbortSignal[] = [AbortSignal.timeout(ms)];
  if (signal) signals.push(signal);
  return AbortSignal.any(signals);
}

/** GET the destination with the TCP connection pinned to its validated address. */
function pinnedGet(destination: Destination, signal: AbortSignal): Promise<IncomingMessage> {
  const { url, address } = destination;
  const secure = url.protocol === "https:";
  const host = url.hostname.replace(/^\[|\]$/g, "");
  return new Promise((resolvePromise, rejectPromise) => {
    const outgoing = (secure ? httpsRequest : httpRequest)({
      host: address,
      port: url.port === "" ? (secure ? 443 : 80) : Number(url.port),
      path: url.pathname + url.search,
      method: "GET",
      // SNI and certificate verification keep the original hostname; an IP literal uses its own identity.
      ...(secure && !isIPv4(host) && !isIPv6(host) ? { servername: host } : {}),
      headers: { host: url.host, "user-agent": USER_AGENT, accept: ACCEPT, "accept-encoding": "identity" },
      signal,
    }, resolvePromise);
    outgoing.on("error", rejectPromise);
    outgoing.end();
  });
}

function headerValue(response: IncomingMessage, name: string): string | undefined {
  const value = response.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/** Read the response body under a hard byte cap; destroy releases the socket on every exit. */
async function readBoundedBody(response: IncomingMessage, limit: number): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  const declared = Number(headerValue(response, "content-length") ?? 0);
  if (declared > limit) {
    response.destroy();
    throw new WebBackendError(`The response exceeds the ${Math.floor(limit / 1024)} KiB limit.`);
  }
  const chunks: Buffer[] = [];
  let total = 0;
  let truncated = false;
  try {
    for await (const chunk of response) {
      if (total + chunk.length > limit) { truncated = true; break; }
      total += chunk.length;
      chunks.push(chunk);
    }
  } finally {
    response.destroy();
  }
  return { bytes: Buffer.concat(chunks), truncated };
}

/** Identity is requested; decode the standard encodings some servers force anyway, with a bounded output. */
function decodeBody(bytes: Uint8Array, encoding: string): Uint8Array {
  if (!encoding || encoding === "identity") return bytes;
  try {
    if (encoding === "gzip") return gunzipSync(bytes, { maxOutputLength: MAX_BODY_BYTES });
    if (encoding === "deflate") return inflateSync(bytes, { maxOutputLength: MAX_BODY_BYTES });
    if (encoding === "br") return brotliDecompressSync(bytes, { maxOutputLength: MAX_BODY_BYTES });
  } catch {
    throw new WebBackendError("The compressed response could not be decoded.");
  }
  throw new WebBackendError("The site returned an unsupported content encoding.");
}

/** Decode with the declared charset (default UTF-8). */
function decodeCharset(bytes: Uint8Array, contentType: string): string {
  const charset = /charset=([\w-]+)/i.exec(contentType)?.[1];
  try { return new TextDecoder(charset ?? "utf-8").decode(bytes); }
  catch { return new TextDecoder("utf-8").decode(bytes); }
}

/** Read a fetch response body under a hard byte cap, decoding with the declared charset (default UTF-8). */
async function readBoundedText(response: Response, limit: number): Promise<{ text: string; truncated: boolean }> {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > limit) {
    await response.body?.cancel().catch(() => undefined);
    throw new WebBackendError(`The response exceeds the ${Math.floor(limit / 1024)} KiB limit.`);
  }
  const body = response.body;
  const reader = body?.getReader();
  if (!body || !reader) {
    await body?.cancel().catch(() => undefined);
    throw new WebBackendError("The response has no body.");
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      if (total + value.length > limit) { truncated = true; await reader.cancel().catch(() => undefined); break; }
      total += value.length;
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  const bytes = Buffer.concat(chunks.map(chunk => Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)));
  return { text: decodeCharset(bytes, response.headers.get("content-type") ?? ""), truncated };
}

/** Bounded HTML-to-text extraction with a maintained parser: title, readable text, and an absolute hyperlink inventory. */
function extractHtmlDocument(html: string, baseUrl: string): { title: string; text: string; links: Array<{ url: string; text: string }>; textTruncated: boolean; linksTruncated: boolean } {
  // <base href> rebases every relative link; script/style/noscript text is excluded from the read.
  const root = parse(html, { blockTextElements: { script: false, style: false, noscript: false } });
  const title = (root.querySelector("title")?.text ?? "").replace(/\s+/g, " ").trim().slice(0, 300);
  let base = baseUrl;
  const baseHref = root.querySelector("base")?.getAttribute("href")?.trim();
  if (baseHref) { try { base = new URL(baseHref, baseUrl).href; } catch { /* keep the document URL */ } }
  // Non-rendering regions (head metadata, embedded media) leave no text once title and base are captured.
  for (const element of root.querySelectorAll("head, script, style, noscript, svg, template, iframe, object, canvas, dialog, video, audio")) element.remove();

  const links: Array<{ url: string; text: string }> = [];
  const seen = new Set<string>();
  for (const anchor of root.querySelectorAll("a")) {
    if (links.length >= MAX_LINKS) break;
    const href = (anchor.getAttribute("href") ?? "").trim();
    if (!href) continue;
    let resolved: URL;
    try { resolved = new URL(href, base); } catch { continue; }
    // Only followable public-web links; javascript:, mailto:, and credential-bearing URLs are dropped.
    if (resolved.protocol !== "http:" && resolved.protocol !== "https:") continue;
    if (resolved.username || resolved.password) continue;
    if (seen.has(resolved.href)) continue;
    seen.add(resolved.href);
    const text = anchor.text.replace(/\s+/g, " ").trim().slice(0, MAX_LINK_TEXT_CHARS);
    links.push({ url: resolved.href, text: text || resolved.hostname });
  }

  const converted = root.structuredText
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { title, text: converted.slice(0, MAX_TEXT_CHARS), links, textTruncated: converted.length > MAX_TEXT_CHARS, linksTruncated: links.length >= MAX_LINKS };
}

/** Create the web-research backend. Search is available only when an Exa API key is configured. */
export function createWebBackend(config: WebBackendConfig = {}): WebBackend {
  const openTimeoutMs = config.requestTimeoutMs ?? OPEN_TIMEOUT_MS;
  const searchApiKey = config.searchApiKey?.trim();

  return {
    async open(url: string, signal?: AbortSignal) {
      // One overall cap across the redirect chain, plus separate DNS and connection/body deadlines.
      const overall = deadline(signal, OPEN_TOTAL_TIMEOUT_MS);
      const hopDeadline = () => deadline(overall, openTimeoutMs);
      let destination = await assertPublicDestination(url, hopDeadline());
      let response: IncomingMessage | undefined;
      let hopSignal = hopDeadline();
      // Manual redirects: every hop is revalidated and re-pinned, so redirects cannot reach a private destination.
      for (let hop = 0; ; hop++) {
        if (hop > MAX_REDIRECTS) { response?.destroy(); throw new WebBackendError("Too many redirects."); }
        hopSignal = hopDeadline();
        try {
          response = await pinnedGet(destination, hopSignal);
        } catch (error) {
          // Surface aborts (cancellation or deadline) as-is; other connection failures as fixed codes only.
          if (hopSignal.aborted) throw error;
          throw new WebBackendError(`The connection failed (${error instanceof Error ? (error as NodeJS.ErrnoException).code ?? error.name : "network error"}).`);
        }
        const status = response.statusCode ?? 0;
        const location = headerValue(response, "location");
        if (status >= 300 && status < 400 && location) {
          response.destroy();
          let target: URL;
          try { target = new URL(location, destination.url); } catch { throw new WebBackendError("The redirect target is not a well-formed URL."); }
          destination = await assertPublicDestination(target.href, hopDeadline());
          continue;
        }
        if (status < 200 || status >= 300) {
          response.destroy();
          throw new WebBackendError(`The site returned HTTP ${status}.`);
        }
        break;
      }
      if (!response) throw new WebBackendError("The response was not received.");
      const contentType = (headerValue(response, "content-type") ?? "").toLowerCase();
      const encoding = (headerValue(response, "content-encoding") ?? "").toLowerCase();
      let raw: string;
      let bodyTruncated: boolean;
      try {
        const read = await readBoundedBody(response, MAX_BODY_BYTES);
        raw = decodeCharset(decodeBody(read.bytes, encoding), contentType);
        bodyTruncated = read.truncated;
      } catch (error) {
        if (hopSignal.aborted) throw error;
        throw new WebBackendError(`The response body could not be read (${error instanceof Error ? (error as NodeJS.ErrnoException).code ?? error.name : "read error"}).`);
      }
      if (contentType === "" || contentType.includes("html")) {
        const document = extractHtmlDocument(raw, destination.url.href);
        return {
          url: destination.url.href,
          title: document.title,
          text: document.text,
          links: document.links,
          truncated: bodyTruncated || document.textTruncated || document.linksTruncated,
        };
      }
      if (contentType.startsWith("text/") || ["json", "xml", "javascript", "csv"].some(part => contentType.includes(part)))
        return { url: destination.url.href, title: "", text: raw.slice(0, MAX_TEXT_CHARS), links: [], truncated: bodyTruncated || raw.length > MAX_TEXT_CHARS };
      throw new WebBackendError(`Unsupported content type (${contentType.split(";")[0].trim() || "unknown"}). Direct reads support HTML and plain text, not PDFs, images, or other binaries.`);
    },

    async search(query: { q: string; recency?: number; domains?: string[] }, signal?: AbortSignal) {
      if (!searchApiKey) throw new WebBackendError("Web search is not configured (no search API key); only direct URL reads are available.");
      const q = query.q.trim();
      if (!q) throw new WebBackendError("The search query is blank.");
      // Fixed public endpoint, so there is no URL surface to validate; the key is sent only to this host.
      const request: Record<string, unknown> = {
        query: q.slice(0, 2000),
        numResults: MAX_RESULTS,
        type: "auto",
        contents: { text: { maxCharacters: MAX_SNIPPET_CHARS } },
      };
      const domains = query.domains
        ?.map(domain => domain.trim().toLowerCase().replace(/^[.*]+|[.*]+$/g, ""))
        .filter(domain => domain.length > 0 && domain.length <= 253)
        .slice(0, 10);
      if (domains?.length) request.includeDomains = domains;
      if (typeof query.recency === "number" && Number.isFinite(query.recency) && query.recency >= 1)
        request.startPublishedDate = new Date(Date.now() - Math.floor(query.recency) * 86_400_000).toISOString().slice(0, 10);
      const response = await fetch(SEARCH_ENDPOINT, {
        method: "POST",
        // Never let a redirect carry the API key anywhere but this fixed endpoint.
        redirect: "error",
        headers: { "content-type": "application/json", "x-api-key": searchApiKey },
        body: JSON.stringify(request),
        signal: deadline(signal, openTimeoutMs),
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        // Status only; provider error bodies stay out of tool-visible text.
        throw new WebBackendError(`The search provider returned HTTP ${response.status}.`);
      }
      const { text } = await readBoundedText(response, MAX_SEARCH_BYTES);
      let parsed: unknown;
      try { parsed = JSON.parse(text); } catch { throw new WebBackendError("The search provider response was not valid JSON."); }
      const results = (parsed as { results?: unknown }).results;
      if (!Array.isArray(results)) throw new WebBackendError("The search provider response had no results array.");
      return results.flatMap(item => {
        const { url, title, text: snippet } = item as { url?: unknown; title?: unknown; text?: unknown };
        if (typeof url !== "string" || !/^https?:\/\//i.test(url)) return [];
        return [{
          url: url.slice(0, 8192),
          title: typeof title === "string" ? title.replace(/\s+/g, " ").trim().slice(0, 300) : "",
          snippet: typeof snippet === "string" ? snippet.slice(0, 4000) : "",
        }];
      }).slice(0, MAX_RESULTS);
    },
  };
}
