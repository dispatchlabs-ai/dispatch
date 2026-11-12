import { defineAgent } from "@dispatch/runner";
import { InspectionTools } from "../../kit/repo-inspection.ts";

export default defineAgent({
  trigger: { mode: "manual" },
  skills: true,
  input: "Independently inspect the exact assigned candidate and report code findings or approval without implementing fixes.",
  extensions: [InspectionTools],
});
