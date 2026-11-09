#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { startWorker } from "./index.js";
const file = process.env.DISPATCH_WORKER_CONFIG;
if (!file)
  throw new Error(
    "Set DISPATCH_WORKER_CONFIG to a consumer-owned configuration file.",
  );
process.umask(0o077);
const worker = await startWorker(JSON.parse(await readFile(file, "utf8")));
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => {
    void worker.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  });
