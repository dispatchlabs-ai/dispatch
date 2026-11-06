import { ThreadProcesses, type ThreadExecutor } from "@dispatch/runner";
import type { SlackThreadInput } from "./index.js";
export type { ThreadLaunch, ThreadExecution as SlackThreadExecution } from "@dispatch/runner";
export type SlackThreadExecutor = ThreadExecutor<SlackThreadInput>;

/** Keeps the existing Slack directory keys and retained profile selection. */
export class SlackThreadProcesses extends ThreadProcesses<SlackThreadInput> {
  constructor(
    directory: string,
    launch: ThreadProcesses<SlackThreadInput>["launch"],
    stopped: ThreadProcesses<SlackThreadInput>["stopped"],
    execute?: SlackThreadExecutor,
  ) {
    super(directory, launch, stopped,
      input => `${input.team}:${input.channel}:${input.thread}`,
      (previous, input) => ({ ...input, agent: previous.agent, profile: previous.profile }), execute);
  }
}
