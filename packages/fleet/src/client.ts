import { request } from "node:http";
import type { FleetRelease, FleetRunStatus } from "./types.js";

export class FleetError extends Error {
  constructor(message: string, readonly code?: string) { super(message); this.name = "FleetError"; }
}

/** This socket is root-only. Put application admission behind a trusted adapter. */
export class FleetClient {
  constructor(readonly socket = "/run/dispatch-fleet/control.sock") {}
  private async call<T>(run: string, operation: string, body?: unknown): Promise<T> {
    if (!/^[a-f0-9]{64}$/.test(run)) throw new Error("Invalid fleet run identity.");
    const payload = body === undefined ? "" : JSON.stringify(body);
    return new Promise((resolve, reject) => {
      const outgoing = request({ socketPath: this.socket, path: `/runs/${run}/${operation}`,
        method: body === undefined ? "GET" : "POST",
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } }, response => {
        const chunks: Buffer[] = [];
        response.on("data", chunk => chunks.push(Buffer.from(chunk)));
        response.on("error", reject);
        response.on("aborted", () => reject(new Error("Fleet response interrupted; reconcile the retained run before repeating an effect.")));
        response.on("end", () => {
          try {
            const value = JSON.parse(Buffer.concat(chunks).toString());
            if (response.statusCode !== 200 || !value.ok) throw new FleetError(value.error ?? "Fleet operation failed.", value.code);
            resolve(value.result);
          } catch (error) { reject(error); }
        });
      });
      outgoing.on("error", reject); outgoing.end(payload);
    });
  }
  ensure(run: string, release: FleetRelease, input: unknown, updateRelease?: "when-idle") {
    return this.call<FleetRunStatus>(run, "ensure", { release, input, updateRelease });
  }
  command<T = unknown>(run: string, command: unknown, timeout?: number, observation = false) {
    return this.call<T>(run, "command", { command, timeout, observation });
  }
  status(run: string) { return this.call<FleetRunStatus>(run, "status"); }
  assignment(run: string) { return this.call<FleetRunStatus["assignment"]>(run, "assignment"); }
  async statusOrUndefined(run: string) {
    try { return await this.status(run); }
    catch (error) { if (error instanceof FleetError && error.code === "RunNotFound") return undefined; throw error; }
  }
  suspend(run: string) { return this.call(run, "suspend", {}); }
  cancel(run: string) { return this.call(run, "cancel", {}); }
  /** The application must first preserve/verify its wanted source and deliverables. */
  finish(run: string) { return this.call(run, "finish", {}); }
}
