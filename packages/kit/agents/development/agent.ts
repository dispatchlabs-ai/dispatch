import { defineAgent } from "@dispatch/runner";
import { CodingTools } from "@earendil-works/pi-durable/tools";

export default defineAgent({
  trigger: { mode: "manual" },
  input: "Deliver the authorized feature or fix through implementation, focused code review and publication. Use cleanup or security remediation only when separately assigned.",
  skills: true,
  messages: ["development", "use-case-tester", "developer", "code-reviewer"],
  extensions: [CodingTools],
});
