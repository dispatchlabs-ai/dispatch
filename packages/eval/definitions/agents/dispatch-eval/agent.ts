import { defineAgent } from "@dispatch/runner";
import { EvaluationExtension } from "../../../src/task.ts";

// Hosts the evaluation task, so `dispatch-eval run` needs no agent from the company's own definitions.
export default defineAgent({
  skills: false,
  trigger: { mode: "manual" },
  input: "Evaluation steps are started with dispatch-eval run.",
  extensions: [EvaluationExtension],
});
