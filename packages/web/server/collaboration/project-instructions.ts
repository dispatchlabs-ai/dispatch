import { defineDoc, section } from "@earendil-works/pi-durable";

export type ProjectInstructionsBinding = {
  projectId?: string;
  instructionsRevision: number;
  markdown: string;
};

/**
 * An execution snapshot, not an editable project setting. Initialize with the participant;
 * replace only in the host's idle-boundary transaction, never during request rendering.
 * Forks require their own project binding, like the collaboration participant binding.
 */
export const ProjectInstructionsBindingDoc = defineDoc<ProjectInstructionsBinding>({
  checkpointWhen: () => false,
  kind: "dispatch.project-instructions-binding", version: 1, scope: "conversation", history: "latest", fork: "initial",
  initial: () => ({ instructionsRevision: 0, markdown: "" }),
});

/** Include in the mandatory collaboration extension; Pi renders individual instructions last. */
export const projectInstructionsSection = section("project-instructions", async (input, context) => {
  const binding = await input.read.snapshot(ProjectInstructionsBindingDoc, input.conversationId, context);
  // Undefined removes a previously rendered section when an empty revision has been adopted.
  return binding?.markdown || undefined;
});
