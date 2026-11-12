import { defineAgent } from "@dispatch/runner";
import { CodingTools } from "@earendil-works/pi-durable/tools";

export default defineAgent({
  trigger: { mode: "manual" },
  skills: true,
  input: "Implement the assigned findings in the owned worktree and return a verified candidate for independent code review.",
  extensions: [CodingTools],
});
