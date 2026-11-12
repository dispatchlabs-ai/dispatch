import { defineAgent } from "@dispatch/runner";
import { InspectionTools } from "../../kit/repo-inspection.ts";

export default defineAgent({
  trigger: { mode: "manual" },
  skills: true,
  input: "Manually validate the assigned use cases and user experience; report findings without fixing them.",
  extensions: [InspectionTools],
});
