import { defineAgent, RequestCompletion } from "@dispatch/runner";
import { CodingTools } from "@earendil-works/pi-durable/tools";

export default defineAgent({
  trigger: { mode: "manual" },
  input: "Complete the user’s current request.",
  skills: true,
  delegates: ["assistant-glm-flash", "assistant-terra", "assistant-sol", "assistant-opus", "assistant-fable"],
  messages: ["development"],
  extensions: [CodingTools, RequestCompletion],
});
