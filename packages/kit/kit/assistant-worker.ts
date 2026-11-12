import { defineAgent } from "@dispatch/runner";
import { CodingTools } from "@earendil-works/pi-durable/tools";

export default defineAgent({
  trigger: { mode: "manual" },
  input: "Complete the coordinator's authorized assignment, verify the result, and return concise findings with evidence.",
  skills: true,
  extensions: [CodingTools],
});
