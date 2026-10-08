import { AdmissionClosedError } from "./admission.js";

/** Process-local ordering, not executor fencing. A successful policy transition
 * joins admitted upstream calls; it cannot reverse effects already performed.
 * Definitions/bootstrap must not use this gate: reconciliation needs them.
 */
export class McpPolicyGate {
  private active = 0;
  private pending = 0;
  private idle: Array<() => void> = [];
  private tail: Promise<void> = Promise.resolve();

  async call<T>(operation: () => Promise<T>): Promise<T> {
    if (this.pending) throw new AdmissionClosedError();
    this.active++;
    try { return await operation(); }
    finally {
      if (--this.active === 0) for (const resolve of this.idle.splice(0)) resolve();
    }
  }

  change<T>(operation: () => Promise<T>): Promise<T> {
    this.pending++;
    const result = this.tail.then(async () => {
      if (this.active) await new Promise<void>(resolve => this.idle.push(resolve));
      return operation();
    }).finally(() => { this.pending--; });
    this.tail = result.then(() => {}, () => {});
    return result;
  }
}
