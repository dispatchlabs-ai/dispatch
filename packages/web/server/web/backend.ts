/*
 * Web research backend: bounded public-web retrieval for the web-research
 * capability. Direct HTTP page reads with public-destination validation and
 * dependency-free HTML-to-text extraction, plus optional Exa-powered search.
 * No browser, no JavaScript rendering, no credential forwarding, and no
 * private-network destinations, including through redirects.
 */
import { lookup } from "node:dns/promises";
import { isIPv4, isIPv6 } from "node:net";
import { WebBackendError, type WebBackend } from "./types.js";

export interface WebBackendConfig {
  /** Exa API key enabling search(); without it only direct URL reads are available. */
  searchApiKey?: string;
  /** Per-request wall-clock cap (default 20s) plus a 60s cap across one open() redirect chain. */
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
  if (groups.every(group => group === 0n)) return true;                                    // ::
  if (groups[0] === 0n && groups[1] === 1n && groups.slice(2).every(g => g === 0n)) return true; // ::1
  if (groups.slice(0, 5).every(g => g === 0n) && groups[5] === 0xffffn)                    // IPv4-mapped
    return isBlockedIPv4(`${Number(groups[6] >> 8n)}.${Number(groups[6] & 0xffn)}.${Number(groups[7] >> 8n)}.${Number(groups[7] & 0xffn)}`);
  if ((groups[0] & 0xfe00n) === 0xfc00n) return true;                                      // fc00::/7 unique local
  if ((groups[0] & 0xff00n) === 0xfe00n) return true;                                      // fe00::/8 link/site-local
  if ((groups[0] & 0xff00n) === 0xff00n) return true;                                      // ff00::/8 multicast
  return groups[0] === 0x2001n && groups[1] === 0xdb8n;                                    // documentation prefix
}

/** Reject anything that is not a public http(s) destination: scheme, credentials, port, host, and DNS. */
async function assertPublicDestination(input: string): Promise<URL> {
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
  } else if (isIPv4(host)) {
    if (isBlockedIPv4(host)) throw new WebBackendError("Private or special IP addresses are not supported.");
  } else {
    // A dotless name could resolve through search domains to an internal host; require a dotted public DNS name.
    if (host.length > 253 || !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host))
      throw new WebBackendError("Expected a public DNS hostname.");
    let addresses: { address: string }[];
    try { addresses = await lookup(host, { all: true }); }
    catch { throw new WebBackendError(`Could not resolve the hostname (${host}).`); }
    // Every resolved address must be public, so an attacker-controlled record cannot mix in a private target.
    if (addresses.length === 0) throw new WebBackendError(`Could not resolve the hostname (${host}).`);
    for (const { address } of addresses)
      if (isIPv4(address) ? isBlockedIPv4(address) : isBlockedIPv6(address))
        throw new WebBackendError("The hostname resolves to a blocked (private or special) address.");
  }
  return url;
}

/** Caller cancellation plus a wall-clock cap; timeout() signals abort with a DOMException "TimeoutError". */
function deadline(signal: AbortSignal | undefined, ms: number): AbortSignal {
  const signals: AbortSignal[] = [AbortSignal.timeout(ms)];
  if (signal) signals.push(signal);
  return AbortSignal.any(signals);
}

/** Read a response body under a hard byte cap, decoding with the declared charset (default UTF-8). */
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
  const charset = /charset=([\w-]+)/i.exec(response.headers.get("content-type") ?? "")?.[1];
  try { return { text: new TextDecoder(charset ?? "utf-8").decode(bytes), truncated }; }
  catch { return { text: new TextDecoder("utf-8").decode(bytes), truncated }; }
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", hellip: "…", mdash: "—", ndash: "–",
  lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", laquo: "«", raquo: "»", copy: "©", reg: "®", trade: "™",
  deg: "°", plusmn: "±", times: "×", divide: "÷", middot: "·", bull: "•", dagger: "†", sect: "§", para: "¶",
  frac12: "½", frac14: "¼", frac34: "¾", sup2: "²", sup3: "³", micro: "µ", shy: "", ensp: " ", emsp: " ",
  thinsp: " ", zwnj: "‌", zwj: "‍", aacute: "á", agrave: "à", acirc: "â", atilde: "ã", auml: "ä",
  eacute: "é", egrave: "è", ecirc: "ê", iacute: "í", igrave: "ì", oacute: "ó", ograve: "ò", ocirc: "ô",
  otilde: "õ", ouml: "ö", uacute: "ú", ugrave: "ù", uuml: "ü", ccedil: "ç", ntilde: "ñ", szlig: "ß",
};

/** Decode common named and all numeric character references; unknown references pass through unchanged. */
function decodeEntities(text: string): string {
  return text.replace(/&(#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z][a-zA-Z0-9]{0,31});/g, (match, entity: string) => {
    if (entity.startsWith("#")) {
      const code = entity[1] === "x" || entity[1] === "X"
        ? Number.parseInt(entity.slice(2), 16)
        : Number.parseInt(entity.slice(1), 10);
      if (!Number.isInteger(code) || code === 0 || (code >= 0xd800 && code <= 0xdfff) || code > 0x10ffff) return match;
      return String.fromCodePoint(code);
    }
    return NAMED_ENTITIES[entity] ?? match;
  });
}

const CLOSING_BLOCKS = /<\/?(?:p|div|section|article|header|footer|nav|aside|main|blockquote|pre|li|ul|ol|dl|dd|dt|h[1-6]|table|thead|tbody|tfoot|tr|figure|figcaption|form|fieldset|address|details|summary|caption|center|marquee)\b[^>]*>/gi;
const NON_RENDERING = /<(script|style|noscript|template|svg|iframe|head|object|canvas|dialog|video|audio)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;

/** Bounded, dependency-free HTML-to-text extraction: title, readable text, and an absolute hyperlink inventory. */
function extractHtmlDocument(html: string, baseUrl: string): { title: string; text: string; links: Array<{ url: string; text: string }>; linksTruncated: boolean } {
  const title = decodeEntities((/<title\b[^>]*>([\s\S]{0,1000}?)<\/title\s*>/i.exec(html)?.[1] ?? "")
    .replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim().slice(0, 300);
  // Comments first (they may hide markup), then non-rendering regions; the title was captured above.
  const body = html.replace(/<!--[\s\S]*?-->/g, "").replace(NON_RENDERING, "").replace(/<(?:script|style|link|meta)\b[^>]*\/?>/gi, "");

  const links: Array<{ url: string; text: string }> = [];
  const seen = new Set<string>();
  const anchors = /<a\b([^>]*)>([\s\S]{0,1000}?)<\/a\s*>/gi;
  for (let match = anchors.exec(body); match; match = anchors.exec(body)) {
    const attributes = /href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(match[1]);
    const href = (attributes?.[1] ?? attributes?.[2] ?? attributes?.[3] ?? "").trim();
    if (!href) continue;
    let resolved: URL;
    try { resolved = new URL(decodeEntities(href), baseUrl); } catch { continue; }
    // Only followable public-web links; javascript:, mailto:, and credential-bearing URLs are dropped.
    if (resolved.protocol !== "http:" && resolved.protocol !== "https:") continue;
    if (resolved.username || resolved.password) continue;
    if (seen.has(resolved.href)) continue;
    seen.add(resolved.href);
    const text = decodeEntities(match[2].replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim().slice(0, MAX_LINK_TEXT_CHARS);
    links.push({ url: resolved.href, text: text || resolved.hostname });
    if (links.length >= MAX_LINKS) break;
  }

  const converted = decodeEntities(body
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<br\b[^>]*\/?>/gi, "\n")
    .replace(/<(?:td|th)\b[^>]*>/gi, " | ")
    .replace(CLOSING_BLOCKS, "\n")
    .replace(/<[^>]*>/g, ""))
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { title, text: converted.slice(0, MAX_TEXT_CHARS), links, linksTruncated: links.length >= MAX_LINKS };
}

/** Create the web-research backend. Search is available only when an Exa API key is configured. */
export function createWebBackend(config: WebBackendConfig = {}): WebBackend {
  const openTimeoutMs = config.requestTimeoutMs ?? OPEN_TIMEOUT_MS;
  const searchApiKey = config.searchApiKey?.trim();

  return {
    async open(url: string, signal?: AbortSignal) {
      // One overall cap across the redirect chain, plus a per-hop cap so no single hop stalls the read.
      const overall = deadline(signal, OPEN_TOTAL_TIMEOUT_MS);
      let destination = await assertPublicDestination(url);
      let response: Response | undefined;
      // Manual redirects: every hop is revalidated exactly like the original destination.
      for (let hop = 0; ; hop++) {
        if (hop > MAX_REDIRECTS) throw new WebBackendError("Too many redirects.");
        response = await fetch(destination, {
          method: "GET",
          redirect: "manual",
          headers: { "user-agent": USER_AGENT, accept: ACCEPT },
          signal: deadline(overall, openTimeoutMs),
        });
        const location = response.headers.get("location");
        if (response.status >= 300 && response.status < 400 && location) {
          await response.body?.cancel().catch(() => undefined);
          let target: URL;
          try { target = new URL(location, destination); } catch { throw new WebBackendError("The redirect target is not a well-formed URL."); }
          destination = await assertPublicDestination(target.href);
          continue;
        }
        break;
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw new WebBackendError(`The site returned HTTP ${response.status}.`);
      }
      const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
      const { text: raw, truncated: bodyTruncated } = await readBoundedText(response, MAX_BODY_BYTES);
      if (contentType === "" || contentType.includes("html")) {
        const document = extractHtmlDocument(raw, destination.href);
        return {
          url: destination.href,
          title: document.title,
          text: document.text,
          links: document.links,
          truncated: bodyTruncated || document.text.length < Math.min(raw.length, MAX_TEXT_CHARS) || document.linksTruncated,
        };
      }
      if (contentType.startsWith("text/") || ["json", "xml", "javascript", "csv"].some(part => contentType.includes(part)))
        return { url: destination.href, title: "", text: raw.slice(0, MAX_TEXT_CHARS), links: [], truncated: bodyTruncated || raw.length > MAX_TEXT_CHARS };
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
