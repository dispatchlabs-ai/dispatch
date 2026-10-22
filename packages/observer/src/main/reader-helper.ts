import { createInterface } from "node:readline";
import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { rmSync } from "node:fs";
import type { RawReadRequest } from "../shared/contracts";

// The standalone helper has no third-party dependencies or Pi execution code.
const config = JSON.parse(
  Buffer.from(process.env.OBSERVER_READER_CONFIG ?? "", "base64").toString(
    "utf8",
  ),
) as { path: string; mode: "stdio" | "http"; directory?: string };
const request = (value: unknown): RawReadRequest => {
  const input = value as Record<string, unknown>;
  for (const key of ["conversationId"])
    if (
      input?.[key] !== undefined &&
      (!Number.isSafeInteger(input[key]) || Number(input[key]) <= 0)
    )
      throw new Error("Invalid reader request");
  const before = input?.before as RawReadRequest["before"];
  if (
    before !== undefined &&
    (!Number.isSafeInteger(before?.sequence) ||
      before.sequence < 0 ||
      !Number.isSafeInteger(before?.entryId) ||
      before.entryId <= 0)
  )
    throw new Error("Invalid history cursor");
  if (
    !Number.isSafeInteger(input?.limit) ||
    Number(input.limit) < 1 ||
    Number(input.limit) > 2000
  )
    throw new Error("Invalid reader page size");
  if (
    input.since !== undefined &&
    (!Number.isSafeInteger(input.since) || Number(input.since) < 0)
  )
    throw new Error("Invalid commit sequence");
  return {
    conversationId: input.conversationId as number | undefined,
    before,
    limit: input.limit as number,
    since: input.since as number | undefined,
  };
};
const cleanup = () => {
  if (config.directory)
    rmSync(config.directory, { force: true, recursive: true });
};
process.on("exit", cleanup);
process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));

async function main() {
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 22 || (major === 22 && minor < 13))
    throw new Error("The remote reader requires Node.js 22.13 or newer.");
  const { readSqlite } = await import("./sqlite");
  if (config.mode === "stdio") {
    const lines = createInterface({ input: process.stdin });
    for await (const line of lines) {
      let id: unknown;
      try {
        const message = JSON.parse(line);
        id = message.id;
        const result = await readSqlite(config.path, request(message.request));
        process.stdout.write(`${JSON.stringify({ id, result })}\n`);
      } catch (error) {
        process.stdout.write(
          `${JSON.stringify({ id, error: error instanceof Error ? error.message : "Reader failed" })}\n`,
        );
      }
    }
  } else {
    const token = randomBytes(32).toString("hex");
    let touched = Date.now();
    const server = createServer(async (req, res) => {
      const supplied = Buffer.from(req.headers.authorization ?? ""),
        expected = Buffer.from(`Bearer ${token}`);
      if (
        supplied.length !== expected.length ||
        !timingSafeEqual(supplied, expected)
      ) {
        res.writeHead(401).end();
        return;
      }
      touched = Date.now();
      if (req.method === "POST" && req.url === "/close") {
        res.end("{}");
        server.close(() => process.exit(0));
        return;
      }
      if (req.method !== "POST" || req.url !== "/read") {
        res.writeHead(404).end();
        return;
      }
      try {
        let body = "";
        for await (const chunk of req) {
          body += chunk;
          if (body.length > 4096) throw new Error("Invalid reader request");
        }
        const result = await readSqlite(config.path, request(JSON.parse(body)));
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ result }));
      } catch (error) {
        res.writeHead(400, { "Content-Type": "application/json" }).end(
          JSON.stringify({
            error: error instanceof Error ? error.message : "Reader failed",
          }),
        );
      }
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      process.stdout.write(
        `${JSON.stringify({ port: typeof address === "object" && address ? address.port : 0, token })}\n`,
      );
    });
    setInterval(() => {
      if (Date.now() - touched > 120_000) server.close(() => process.exit(0));
    }, 10_000).unref();
  }
}
void main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Reader failed");
  process.exitCode = 1;
});
