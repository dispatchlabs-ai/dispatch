import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { createInterface } from "node:readline";
import { delimiter, join } from "node:path";
import { homedir } from "node:os";
import type {
  Connection,
  RawSnapshot,
  RawReadRequest,
  Transport,
} from "../shared/contracts";

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
export const errorText = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
function child(command: string, args: string[]) {
  // Apps launched by Finder do not inherit an interactive shell's Homebrew/Nix path.
  const additional =
    process.platform === "win32"
      ? [
          join(
            process.env.ProgramFiles ?? "C:\\Program Files",
            "Amazon",
            "AWSCLIV2",
          ),
          join(
            process.env.ProgramFiles ?? "C:\\Program Files",
            "Amazon",
            "SessionManagerPlugin",
            "bin",
          ),
        ]
      : [
          "/opt/homebrew/bin",
          "/usr/local/bin",
          join(homedir(), ".local/bin"),
          join(homedir(), ".nix-profile/bin"),
        ];
  const env = {
    ...process.env,
    PATH: [...(process.env.PATH ?? "").split(delimiter), ...additional]
      .filter(Boolean)
      .join(delimiter),
  };
  return spawn(command, args, {
    stdio: "pipe",
    windowsHide: true,
    shell: false,
    env,
  });
}
async function command(command: string, args: string[]): Promise<string> {
  const process = child(command, args);
  return new Promise((resolve, reject) => {
    let stdout = "",
      stderr = "";
    process.stdout.on("data", (data) => {
      stdout += data;
    });
    process.stderr.on("data", (data) => {
      stderr = (stderr + data).slice(-12000);
    });
    const timer = setTimeout(() => {
      process.kill();
      reject(
        new Error(
          `${command} timed out. Check its installed CLI and credentials.`,
        ),
      );
    }, 60_000);
    process.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    process.once("close", (code) => {
      clearTimeout(timer);
      code === 0
        ? resolve(stdout)
        : reject(
            new Error(stderr.trim() || `${command} exited with status ${code}`),
          );
    });
  });
}
function sshArgs(transport: Extract<Transport, { kind: "ssh" }>): string[] {
  return [
    "-T",
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    "ConnectTimeout=15",
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=3",
    ...(transport.port ? ["-p", String(transport.port)] : []),
    ...(transport.user ? ["-l", transport.user] : []),
    ...(transport.identityFile ? ["-i", transport.identityFile] : []),
    "--",
    transport.host,
  ];
}
function awsArgs(transport: Extract<Transport, { kind: "ssm" }>) {
  return [
    "--region",
    transport.region,
    ...(transport.profile ? ["--profile", transport.profile] : []),
    "--no-cli-pager",
  ];
}
export interface Tunnel {
  port: number;
  close(): Promise<void>;
  assertHealthy(): void;
}
async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Could not allocate a local tunnel port");
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}
async function waitForPort(port: number, failure: () => string | undefined) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const message = failure();
    if (message) throw new Error(message);
    const open = await new Promise<boolean>((resolve) => {
      const socket = createConnection({ port, host: "127.0.0.1" });
      const finish = (value: boolean) => {
        socket.destroy();
        resolve(value);
      };
      socket.once("connect", () => finish(true));
      socket.once("error", () => finish(false));
      socket.setTimeout(500, () => finish(false));
    });
    if (open) return;
    await delay(200);
  }
  throw new Error(
    "The tunnel did not open. Check host access and the SSH or Session Manager configuration.",
  );
}
export async function openTunnel(
  transport: Exclude<Transport, { kind: "direct" }>,
  targetHost: string,
  targetPort: number,
): Promise<Tunnel> {
  const port = await freePort();
  let process: ChildProcessWithoutNullStreams;
  if (transport.kind === "ssh") {
    const base = sshArgs(transport),
      split = base.indexOf("--");
    process = child("ssh", [
      ...base.slice(0, split),
      "-N",
      "-o",
      "ExitOnForwardFailure=yes",
      "-L",
      `127.0.0.1:${port}:${targetHost.includes(":") ? `[${targetHost}]` : targetHost}:${targetPort}`,
      ...base.slice(split),
    ]);
  } else {
    const localHost = targetHost === "127.0.0.1";
    process = child("aws", [
      ...awsArgs(transport),
      "ssm",
      "start-session",
      "--target",
      transport.instance,
      "--document-name",
      localHost
        ? "AWS-StartPortForwardingSession"
        : "AWS-StartPortForwardingSessionToRemoteHost",
      "--parameters",
      JSON.stringify({
        portNumber: [String(targetPort)],
        localPortNumber: [String(port)],
        ...(!localHost ? { host: [targetHost] } : {}),
      }),
    ]);
  }
  let failure: string | undefined,
    stderr = "",
    sessionId: string | undefined;
  process.stderr.on("data", (data) => {
    stderr = (stderr + data).slice(-6000);
  });
  process.stdout.on("data", (data) => {
    sessionId ??= /SessionId:\s*(\S+)/.exec(String(data))?.[1];
  });
  process.once("error", (error) => {
    failure = error.message;
  });
  process.once("exit", (code) => {
    failure =
      stderr.trim() ||
      `Tunnel closed (${code ?? "signal"}). Reconnect to open a new viewer connection.`;
  });
  const close = async () => {
    process.kill();
    if (sessionId && transport.kind === "ssm")
      await command("aws", [
        ...awsArgs(transport),
        "ssm",
        "terminate-session",
        "--session-id",
        sessionId,
      ]).catch(() => {});
  };
  try {
    await waitForPort(port, () => failure);
  } catch (error) {
    await close();
    throw error;
  }
  return {
    port,
    close,
    assertHealthy: () => {
      if (failure) throw new Error(failure);
    },
  };
}
export interface RemoteReader {
  read(request: RawReadRequest): Promise<RawSnapshot>;
  close(): Promise<void>;
}
export async function openRemoteReader(
  connection: Connection,
): Promise<RemoteReader> {
  const transport = connection.transport;
  if (transport.kind === "direct")
    throw new Error("Choose a transport for remote SQLite");
  const helper = await readFile(join(__dirname, "reader.cjs"), "utf8");
  if (transport.kind === "ssh") {
    const config = Buffer.from(
      JSON.stringify({ path: connection.path, mode: "stdio" }),
    ).toString("base64");
    const remoteCommand = `OBSERVER_READER_CONFIG=${quote(config)} ${quote(transport.node)} -e ${quote(helper)}`;
    const process = child("ssh", [...sshArgs(transport), remoteCommand]);
    const pending = new Map<
      number,
      {
        resolve(value: RawSnapshot): void;
        reject(error: Error): void;
        timer: ReturnType<typeof setTimeout>;
      }
    >();
    let nextId = 0,
      failure: Error | undefined,
      stderr = "";
    const fail = (error: Error) => {
      failure = error;
      for (const item of pending.values()) {
        clearTimeout(item.timer);
        item.reject(error);
      }
      pending.clear();
    };
    process.stderr.on("data", (data) => {
      stderr = (stderr + data).slice(-6000);
    });
    process.on("error", fail);
    process.on("exit", (code) =>
      fail(
        new Error(
          stderr.trim() ||
            `Remote reader closed (${code ?? "signal"}). It requires Node.js 22.13+ and an existing database readable by the SSH identity.`,
        ),
      ),
    );
    createInterface({ input: process.stdout }).on("line", (line) => {
      try {
        const message = JSON.parse(line),
          item = pending.get(message.id);
        if (!item) return;
        pending.delete(message.id);
        clearTimeout(item.timer);
        message.error
          ? item.reject(new Error(message.error))
          : item.resolve(message.result);
      } catch {
        fail(
          new Error(
            "The SSH host returned an invalid reader response. Check for shell startup text on stdout.",
          ),
        );
      }
    });
    return {
      read: (request) =>
        new Promise((resolve, reject) => {
          if (failure) {
            reject(failure);
            return;
          }
          const id = ++nextId;
          const timer = setTimeout(() => {
            pending.delete(id);
            reject(
              new Error(
                "The remote reader timed out. Reconnect after checking the host.",
              ),
            );
            process.kill();
          }, 60_000);
          pending.set(id, { resolve, reject, timer });
          process.stdin.write(`${JSON.stringify({ id, request })}\n`);
        }),
      close: async () => {
        process.stdin.end();
        process.kill();
        fail(new Error("Reader disconnected"));
      },
    };
  }
  // A private, expiring helper is created only for the explicitly selected source.
  // SSM owns its audit trail; no agent service, deployment or IAM policy is changed.
  const encodedHelper = Buffer.from(helper).toString("base64");
  const config = Buffer.from(
    JSON.stringify({ path: connection.path, mode: "http" }),
  ).toString("base64");
  const bootstrap = `const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),cp=require('node:child_process');const d=fs.mkdtempSync(path.join(os.tmpdir(),'dispatch-observer-'));fs.chmodSync(d,448);const f=path.join(d,'reader.cjs');fs.writeFileSync(f,Buffer.from('${encodedHelper}','base64'),{mode:384});const c=JSON.parse(Buffer.from('${config}','base64'));c.directory=d;const out=fs.openSync(path.join(d,'ready'),'w',384),err=fs.openSync(path.join(d,'error'),'w',384);const p=cp.spawn(process.execPath,[f],{detached:true,stdio:['ignore',out,err],env:{...process.env,OBSERVER_READER_CONFIG:Buffer.from(JSON.stringify(c)).toString('base64')}});p.unref();fs.closeSync(out);fs.closeSync(err);let n=0;const t=setInterval(()=>{const s=fs.readFileSync(path.join(d,'ready'),'utf8');if(s.trim()){clearInterval(t);console.log(s.trim());}else if(++n>100){clearInterval(t);try{process.kill(p.pid)}catch{};const e=fs.readFileSync(path.join(d,'error'),'utf8');fs.rmSync(d,{recursive:true,force:true});console.error(e||'Reader did not start');process.exitCode=1;}},100);`;
  const sent = JSON.parse(
    await command("aws", [
      ...awsArgs(transport),
      "ssm",
      "send-command",
      "--instance-ids",
      transport.instance,
      "--document-name",
      "AWS-RunShellScript",
      "--parameters",
      JSON.stringify({
        commands: [`${quote(transport.node)} -e ${quote(bootstrap)}`],
        executionTimeout: ["30"],
      }),
      "--output",
      "json",
    ]),
  );
  let output = "";
  for (const deadline = Date.now() + 60_000; Date.now() < deadline; ) {
    await delay(1000);
    let reply;
    try {
      reply = JSON.parse(
        await command("aws", [
          ...awsArgs(transport),
          "ssm",
          "get-command-invocation",
          "--command-id",
          sent.Command.CommandId,
          "--instance-id",
          transport.instance,
          "--output",
          "json",
        ]),
      );
    } catch (error) {
      if (errorText(error).includes("InvocationDoesNotExist")) continue;
      throw error;
    }
    if (reply.Status === "Success") {
      output = reply.StandardOutputContent.trim();
      break;
    }
    if (
      ["Failed", "Cancelled", "TimedOut", "Cancelling"].includes(reply.Status)
    )
      throw new Error(
        reply.StandardErrorContent ||
          "The SSM reader could not start. It requires Node.js 22.13+ and a Linux target.",
      );
  }
  if (!output)
    throw new Error(
      "The SSM reader startup timed out. Any started helper expires after two idle minutes.",
    );
  const startup = JSON.parse(output) as { port: number; token: string };
  if (!Number.isInteger(startup.port) || !/^[a-f0-9]{64}$/.test(startup.token))
    throw new Error("Invalid SSM reader startup response");
  const tunnel = await openTunnel(transport, "127.0.0.1", startup.port);
  const send = async (route: string, body: unknown) => {
    tunnel.assertHealthy();
    const response = await fetch(`http://127.0.0.1:${tunnel.port}/${route}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${startup.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
    const reply = (await response.json()) as {
      result: RawSnapshot;
      error?: string;
    };
    if (!response.ok || reply.error)
      throw new Error(
        reply.error ?? "The remote reader could not serve this snapshot",
      );
    return reply.result;
  };
  return {
    read: (request) => send("read", request),
    close: async () => {
      await send("close", {}).catch(() => {});
      await tunnel.close();
    },
  };
}
