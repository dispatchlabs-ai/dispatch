import {
  discoverOAuthServerInfo, exchangeAuthorization, extractWWWAuthenticateParams,
  refreshAuthorization, registerClient, selectClientAuthMethod, startAuthorization,
} from "@modelcontextprotocol/sdk/client/auth.js";
import { checkResourceAllowed, resourceUrlFromServerUrl } from "@modelcontextprotocol/sdk/shared/auth-utils.js";
import type { AuthorizationServerMetadata, OAuthClientInformationMixed, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { z } from "zod";

export class ConnectionError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export class RenewalError extends ConnectionError {
  constructor(readonly retryable: boolean, message: string) { super(retryable ? 503 : 401, message); }
}

function connectionNotEstablished(error: unknown): boolean {
  if (error instanceof AggregateError) return error.errors.length > 0 && error.errors.every(connectionNotEstablished);
  if (!(error instanceof Error)) return false;
  if ("code" in error && ["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "ENETUNREACH", "EHOSTUNREACH", "UND_ERR_CONNECT_TIMEOUT"].includes(String(error.code))) return true;
  return connectionNotEstablished(error.cause);
}

export function connectionURL(value: string | URL) {
  const url = new URL(value);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) || url.username || url.password || url.hash) {
    throw new ConnectionError(400, "Use an HTTPS server URL, or HTTP on localhost, without embedded credentials or a fragment.");
  }
  return url;
}

export const oauthFetch: typeof fetch = (input, init) => {
  const url = connectionURL(input instanceof Request ? input.url : input);
  return fetch(url, { ...init, redirect: "error", signal: init?.signal ?? AbortSignal.timeout(30_000) });
};

const extraMetadata = z.object({
  revocation_endpoint: z.url().optional(),
  revocation_endpoint_auth_methods_supported: z.array(z.string()).optional(),
  authorization_response_iss_parameter_supported: z.boolean().optional(),
});
export type OAuthConfiguration = {
  issuer: string;
  resource: string;
  metadata: AuthorizationServerMetadata & z.infer<typeof extraMetadata>;
  requestedScopes: string[];
};
export type StoredTokens = OAuthTokens & { expiresAt?: number };

export async function prepareOAuth(endpoint: string, redirectURI: string, state: string, options: {
  scopes?: string[]; clientId?: string; clientSecret?: string; expectedIssuer?: string;
}) {
  try { return await prepareOAuthRequest(endpoint, redirectURI, state, options); }
  catch (error) {
    if (error instanceof ConnectionError) throw error;
    // Provider error bodies may contain credential material; never log or expose them.
    throw new ConnectionError(502, "OAuth setup could not be completed. Check the server URL and any registered client details, then try again.");
  }
}

async function prepareOAuthRequest(endpoint: string, redirectURI: string, state: string, options: {
  scopes?: string[]; clientId?: string; clientSecret?: string; expectedIssuer?: string;
}) {
  // Read the resource server's challenge before metadata discovery. A GET does
  // not invoke tools; cancel a stream immediately after receiving its headers.
  const response = await oauthFetch(endpoint, { headers: { Accept: "application/json, text/event-stream" } });
  const challenge = extractWWWAuthenticateParams(response);
  await response.body?.cancel();
  const extensions = new Map<string, z.infer<typeof extraMetadata>>();
  const discoveryFetch: typeof fetch = async (input, init) => {
    const reply = await oauthFetch(input, init);
    if (reply.ok && reply.headers.get("content-type")?.includes("application/json")) {
      const document: unknown = await reply.clone().json();
      if (document && typeof document === "object" && "issuer" in document && typeof document.issuer === "string") {
        extensions.set(document.issuer, extraMetadata.parse(document));
      }
    }
    return reply;
  };
  const info = await discoverOAuthServerInfo(endpoint, { resourceMetadataUrl: challenge.resourceMetadataUrl, fetchFn: discoveryFetch });
  const discovered = info.authorizationServerMetadata;
  // The SDK's OIDC schema omits revocation and issuer-response extensions.
  const metadata = discovered ? { ...discovered, ...extensions.get(discovered.issuer), ...extraMetadata.parse(discovered) } : undefined;
  const issuer = connectionURL(info.authorizationServerUrl).href;
  if (!metadata || connectionURL(metadata.issuer).href !== issuer) {
    throw new ConnectionError(400, "The server did not provide valid OAuth issuer metadata. Check the URL or use its documented token/header authentication.");
  }
  if (options.expectedIssuer && connectionURL(options.expectedIssuer).href !== issuer) {
    throw new ConnectionError(400, "The server's OAuth issuer changed. Create a new connection with the provider's current client details.");
  }
  for (const url of [metadata.authorization_endpoint, metadata.token_endpoint, metadata.registration_endpoint, metadata.revocation_endpoint]) {
    if (url) connectionURL(url);
  }
  if (!metadata.code_challenge_methods_supported?.includes("S256")) {
    throw new ConnectionError(400, "The authorization server must advertise PKCE S256 support.");
  }
  const resource = info.resourceMetadata?.resource ?? resourceUrlFromServerUrl(endpoint).href;
  if (!checkResourceAllowed({ requestedResource: resourceUrlFromServerUrl(endpoint), configuredResource: resource })) {
    throw new ConnectionError(400, "The authorization metadata describes a different MCP server.");
  }
  const requestedScopes = options.scopes ?? challenge.scope?.split(/\s+/).filter(Boolean) ?? info.resourceMetadata?.scopes_supported ?? [];
  const scope = requestedScopes.join(" ") || undefined;
  let client: OAuthClientInformationMixed;
  if (options.clientId) {
    client = { client_id: options.clientId, issuer, ...(options.clientSecret ? { client_secret: options.clientSecret } : {}) };
  } else {
    if (!metadata.registration_endpoint) throw new ConnectionError(400, "This server requires a registered OAuth client. Enter its client ID in Advanced OAuth settings.");
    client = await registerClient(issuer, { metadata, scope, fetchFn: oauthFetch, clientMetadata: {
      client_name: "Dispatch", redirect_uris: [redirectURI], token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"], response_types: ["code"],
    } });
    client = { ...client, issuer };
    if ("redirect_uris" in client && !client.redirect_uris.includes(redirectURI)) throw new ConnectionError(400, "The authorization server did not register Dispatch's callback URL.");
  }
  const authorization = await startAuthorization(issuer, { metadata, clientInformation: client, redirectUrl: redirectURI, scope, state, resource });
  return { config: { issuer, resource, metadata, requestedScopes } satisfies OAuthConfiguration, client, ...authorization };
}

export function storedTokens(tokens: OAuthTokens, config: OAuthConfiguration, previous?: StoredTokens): StoredTokens {
  if (!tokens.access_token || (tokens.expires_in !== undefined && (!Number.isFinite(tokens.expires_in) || tokens.expires_in <= 0))) {
    throw new ConnectionError(400, "The authorization server returned an invalid token response.");
  }
  if (tokens.token_type.toLowerCase() !== "bearer") throw new ConnectionError(400, "The authorization server returned an unsupported token type.");
  const scope = tokens.scope ?? previous?.scope ?? config.requestedScopes.join(" ");
  const allowed = previous?.scope?.split(/\s+/).filter(Boolean) ?? config.requestedScopes;
  if (allowed.length && scope.split(/\s+/).filter(Boolean).some(value => !allowed.includes(value))) {
    throw new ConnectionError(400, "The authorization server returned permissions beyond the requested scope.");
  }
  return { ...tokens, issuer: config.issuer, scope, ...(tokens.expires_in === undefined ? {} : { expiresAt: Date.now() + tokens.expires_in * 1000 }) };
}

export async function exchangeCode(config: OAuthConfiguration, client: OAuthClientInformationMixed, code: string, verifier: string, redirectURI: string) {
  return storedTokens(await exchangeAuthorization(config.issuer, { metadata: config.metadata, clientInformation: client,
    authorizationCode: code, codeVerifier: verifier, redirectUri: redirectURI, resource: config.resource, fetchFn: oauthFetch }), config);
}

export async function refreshTokens(config: OAuthConfiguration, client: OAuthClientInformationMixed, previous: StoredTokens) {
  if (!previous.refresh_token) throw new RenewalError(false, "This server did not issue a refresh token. Authorize the connection again.");
  // Use the single-exchange primitive: an uncertain rotating refresh must never
  // trigger another exchange or an unattended authorization flow.
  const refreshFetch: typeof fetch = async (input, init) => {
    const response = await oauthFetch(input, init);
    if (!response.ok) {
      // The SDK also maps malformed/non-OAuth responses to ServerError. Inspect
      // the actual response so those cannot be mistaken for a safe retry.
      const body: unknown = await response.clone().json().catch(() => undefined);
      const code = body && typeof body === "object" && "error" in body ? body.error : undefined;
      if (code === "server_error" || code === "temporarily_unavailable") {
        await response.body?.cancel();
        throw new RenewalError(true, "Credential renewal is temporarily unavailable. Try again.");
      }
      if (code === "invalid_grant" || code === "invalid_client" || code === "unauthorized_client") {
        await response.body?.cancel();
        throw new RenewalError(false, "The server rejected the renewal credentials. Authorize this connection again.");
      }
    }
    return response;
  };
  try {
    return storedTokens(await refreshAuthorization(config.issuer, { metadata: config.metadata, clientInformation: client,
      refreshToken: previous.refresh_token, resource: config.resource, fetchFn: refreshFetch }), config, previous);
  } catch (error) {
    // Only failures known not to have exchanged the token can be retried.
    // A timeout/reset after sending, or a malformed success, may hide rotation.
    if (error instanceof RenewalError) throw error;
    if (connectionNotEstablished(error)) {
      throw new RenewalError(true, "Credential renewal is temporarily unavailable. Try again.");
    }
    // Never retain provider descriptions: they can contain credential material.
    throw new RenewalError(false, "Credential renewal has an uncertain outcome. Authorize this connection again.");
  }
}

export async function revokeTokens(config: OAuthConfiguration, client: OAuthClientInformationMixed, tokens: StoredTokens) {
  if (!config.metadata.revocation_endpoint) return false;
  const method = selectClientAuthMethod(client, config.metadata.revocation_endpoint_auth_methods_supported ?? config.metadata.token_endpoint_auth_methods_supported ?? []);
  const headers = new Headers({ "Content-Type": "application/x-www-form-urlencoded" });
  for (const token of [tokens.refresh_token, tokens.access_token].filter((value): value is string => Boolean(value))) {
    const params = new URLSearchParams({ token, client_id: client.client_id });
    if (method === "client_secret_basic" && client.client_secret) {
      const encoded = (value: string) => new URLSearchParams({ value }).toString().slice(6);
      headers.set("Authorization", `Basic ${Buffer.from(`${encoded(client.client_id)}:${encoded(client.client_secret)}`).toString("base64")}`);
      params.delete("client_id");
    } else if (method === "client_secret_post" && client.client_secret) params.set("client_secret", client.client_secret);
    const response = await oauthFetch(config.metadata.revocation_endpoint, { method: "POST", headers, body: params });
    await response.body?.cancel();
    if (!response.ok) throw new ConnectionError(502, "Local access is disabled, but server revocation is unconfirmed. Retry disconnecting.");
  }
  return true;
}
