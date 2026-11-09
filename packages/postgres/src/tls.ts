import { X509Certificate } from "node:crypto";
import { checkServerIdentity } from "node:tls";
import type { ClientConfig } from "pg";

/** Verified PostgreSQL TLS for backend, launcher and bootstrapped worker clients. */
export function verifiedPostgresConfig(connectionString: string, ca: string): ClientConfig {
  try {
    const url = new URL(connectionString);
    // pg URL SSL parameters can replace the explicit ssl object. Reject all URL
    // parameters, including libpq options/service/socket overrides, not just sslmode.
    if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.hostname || !url.username || url.pathname.length < 2 || url.pathname.slice(1).includes("/") || url.href.includes("?") || url.href.includes("#"))
      throw new Error("Invalid PostgreSQL URL.");
    const pemPattern = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g;
    const certificates = ca.match(pemPattern);
    if (!certificates?.length || ca.replace(pemPattern, "").trim()) throw new Error("Invalid CA bundle.");
    for (const pem of certificates) if (!new X509Certificate(pem).ca) throw new Error("Expected CA certificate.");
    const expectedHost = url.hostname.replace(/^\[|\]$/g, "");
    return { connectionString, ssl: {
      ca, rejectUnauthorized: true, minVersion: "TLSv1.2",
      // pg omits servername for IP hosts. Bind verification to the URL host,
      // never the TLS library's fallback identity when using a supplied socket.
      checkServerIdentity: (_hostname, certificate) => checkServerIdentity(expectedHost, certificate),
    } };
  } catch {
    throw new Error("PostgreSQL requires an explicit host/user/database URL without parameters and a valid CA bundle.");
  }
}
