import { defineExtension } from "@earendil-works/pi-durable";
import { createBashTool, createReadTool } from "@earendil-works/pi-durable/tools";

// Shell access is needed for Git, Dev Containers and browser inspection.
// Omitting edit/write reduces accidental edits; this is not a filesystem sandbox.
export const InspectionTools = defineExtension({
  name: "kit.repo-inspection",
  tools: [createReadTool(), createBashTool()],
});
