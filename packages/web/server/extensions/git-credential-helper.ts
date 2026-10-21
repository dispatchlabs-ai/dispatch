// Git invokes this helper in a subprocess. Credential bytes go only to Git's pipe.
import { connect } from "node:net";

async function main() {
  const [socketPath, operation] = process.argv.slice(2);
  if (!socketPath || operation !== "get") return; // Never store credentials.
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk.toString();
    if (input.length > 8192) throw new Error("Invalid request");
  }
  const fields = Object.fromEntries(input.trim().split("\n").map(line => {
    const equal = line.indexOf("=");
    return [line.slice(0, equal), line.slice(equal + 1)];
  }));
  const response = await new Promise<string>((resolve, reject) => {
    const socket = connect(socketPath);
    let text = "";
    socket.setTimeout(30000, () => socket.destroy(new Error("Timed out")));
    socket.on("error", reject);
    socket.on("connect", () => socket.write(JSON.stringify({ protocol: fields.protocol, host: fields.host, path: fields.path }) + "\n"));
    socket.on("data", chunk => {
      text += chunk.toString();
      if (text.length > 32768) socket.destroy(new Error("Invalid response"));
    });
    socket.on("end", () => resolve(text));
  });
  const credential: unknown = JSON.parse(response);
  if (typeof credential !== "string" || !/^[\x21-\x7e]{1,16384}$/.test(credential)) throw new Error("Invalid credential");
  process.stdout.write(`username=x-access-token\npassword=${credential}\n\n`);
}

// Do not echo errors, received data, or a stack containing credential material.
main().catch(() => { process.exitCode = 1; });
