#!/usr/bin/env node
import { watchCommand } from "./watch.js";
import { terminalError } from "./terminal-output.js";

try {
  await watchCommand(process.argv.slice(2));
} catch (error) {
  console.error(terminalError(error).message);
  process.exitCode = 1;
}
