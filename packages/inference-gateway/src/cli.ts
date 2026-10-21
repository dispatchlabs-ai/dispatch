#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { createModels } from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { parseConfig } from "./config.js";
import { SecretsCredentialStore } from "./credentials.js";
import { EcsOwnership } from "./ownership.js";
import { createGatewayServer } from "./server.js";
import { accessCommand } from "./access-cli.js";

async function main() {
  if (process.argv[2] === "auth") { await accessCommand(process.argv.slice(3)); return; }
  const [command = "serve", path = process.env.DISPATCH_GATEWAY_CONFIG, connectionId] = process.argv.slice(2);
  if (!path) throw new Error("Usage: dispatch-inference-gateway serve CONFIG | login CONFIG CONNECTION");
  let contents: string;
  if (path.startsWith("s3://")) {
    const location = new URL(path);
    const s3 = new S3Client({});
    try {
      const object = await s3.send(new GetObjectCommand({ Bucket: location.hostname, Key: location.pathname.slice(1) }));
      contents = await object.Body!.transformToString();
    } finally { s3.destroy(); }
    const digest = process.env.DISPATCH_GATEWAY_CONFIG_SHA256;
    if (!digest || createHash("sha256").update(contents).digest("hex") !== digest) throw new Error("Configuration checksum mismatch");
  } else contents = await readFile(path, "utf8");
  const config = parseConfig(JSON.parse(contents));
  if (command === "login") {
    const connection = config.connections.find((item) => item.id === connectionId);
    if (!connection) throw new Error("Unknown connection");
    const provider = builtinProviders().find((item) => item.id === connection.provider);
    if (!provider?.auth.oauth) throw new Error("This provider does not offer OAuth login");
    const secrets = new SecretsManagerClient({ region: config.region });
    const models = createModels({ credentials: new SecretsCredentialStore(secrets, connection.secretId, connection.provider) });
    models.setProvider(provider);
    const input = createInterface({ input: process.stdin, output: process.stdout });
    try {
      await models.login(provider.id, "oauth", {
        notify: (event) => process.stdout.write(`${JSON.stringify(event)}\n`),
        prompt: (prompt) => input.question(`${prompt.message}\n${prompt.type === "select" ? prompt.options.map((option) => `${option.id}: ${option.label}`).join("\n") + "\n" : ""}> `, { signal: prompt.signal }),
      }, { agentName: "Dispatch inference gateway" });
      process.stdout.write("OAuth credential saved in AWS Secrets Manager.\n");
    } finally { input.close(); secrets.destroy(); }
    return;
  }
  if (command !== "serve") throw new Error("Unknown command");
  const clusterArn = process.env.DISPATCH_GATEWAY_ECS_CLUSTER;
  const service = process.env.DISPATCH_GATEWAY_ECS_SERVICE;
  const table = process.env.DISPATCH_GATEWAY_OWNER_TABLE;
  if ([clusterArn, service, table].some(Boolean) && !(clusterArn && service && table)) throw new Error("Incomplete ECS coordination configuration");
  const ownership = clusterArn && service && table ? new EcsOwnership({ region: config.region, clusterArn, service, table }) : undefined;
  await ownership?.start();
  const { server, closeCredentials } = await createGatewayServer(config, [], ownership);
  server.listen(config.port, config.host, () => process.stdout.write(`Gateway listening on ${config.host}:${config.port}\n`));
  const stop = () => {
    void ownership?.beginDrain().catch(() => undefined);
    server.close(() => { void closeCredentials().then(() => { ownership?.close(); process.exit(0); }); });
    setTimeout(() => process.exit(1), 110_000).unref();
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

main().catch(() => { process.stderr.write("Gateway startup or credential operation failed. Check configuration, IAM access, and provider authorization.\n"); process.exitCode = 1; });
