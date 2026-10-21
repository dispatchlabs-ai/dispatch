import { readFile } from "node:fs/promises";
import { awsGatewayAuthorization } from "./aws.js";
import { gatewayOrigin } from "./config.js";
import { employeeGatewayAuthorization, employeeLogin, employeeLogout } from "./employee.js";

export async function accessCommand(args: string[]) {
  const [command, url, ...rest] = args;
  if (!url || !["login", "token", "logout", "request", "admin"].includes(command)) throw new Error("Usage: auth login|token|logout URL | auth request|admin URL METHOD /v1/PATH [JSON_FILE]");
  const origin = gatewayOrigin(url);
  if (command === "login") {
    const credential = await employeeLogin(origin, rest[0] ?? "Gateway CLI");
    process.stdout.write(`${JSON.stringify({ signedIn: true, credential })}\n`); return;
  }
  if (command === "logout") { await employeeLogout(origin); process.stdout.write("Signed out.\n"); return; }
  const authorize = command === "admin" ? awsGatewayAuthorization(origin) : employeeGatewayAuthorization(origin);
  if (command === "token") { process.stdout.write(`${await authorize()}\n`); return; }
  const [method = "GET", path = "/v1/me", input] = rest;
  if (!["GET", "POST", "PUT", "DELETE"].includes(method) || !path.startsWith("/v1/") || new URL(path, origin).origin !== origin) throw new Error("Use a gateway /v1/ path and GET, POST, PUT, or DELETE");
  const body = input ? await readFile(input === "-" ? "/dev/stdin" : input, "utf8") : undefined;
  if (body) JSON.parse(body);
  const response = await fetch(`${origin}${path}`, { method, headers: { authorization: `Bearer ${await authorize()}`, ...(body ? { "content-type": "application/json" } : {}) }, body, redirect: "error", signal: AbortSignal.timeout(30_000) });
  process.stdout.write(`${await response.text()}\n`);
  if (!response.ok) process.exitCode = 1;
}
