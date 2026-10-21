import type { Usage } from "@earendil-works/pi-ai";
import type { AccessStore, UsageReceipt } from "./access-store.js";
import type { Principal } from "./config.js";

export class RequestUsage {
  private settlement?: Promise<void>;
  readonly receipt: UsageReceipt;
  constructor(private readonly store: AccessStore | undefined, requestId: string, principal: Principal, connection: string, model: string, operation: string) {
    this.receipt = { requestId, principalId: principal.id, clientId: principal.clientId, connection, model, operation, startedAt: Date.now(), status: "pending" };
  }
  admit(principal: Principal, checkBudget = true) { return this.store?.admit(principal, this.receipt, checkBudget) ?? Promise.resolve([]); }
  finish(status: string, usage?: Usage, deferredUsageKey?: string) {
    return this.settlement ??= this.settle(status, usage, deferredUsageKey);
  }
  private async settle(status: string, usage?: Usage, deferredUsageKey?: string) {
    const receipt = { ...this.receipt, status, durationMs: Date.now() - this.receipt.startedAt, usage, deferredUsageKey };
    try {
      await this.store?.settle(receipt);
      process.stdout.write(`${JSON.stringify({ ...receipt, accounted: Boolean(this.store) })}\n`);
    } catch (error) {
      process.stdout.write(`${JSON.stringify({ ...receipt, accounted: false, event: "usage_settlement_failed" })}\n`);
      throw error;
    }
  }
}
