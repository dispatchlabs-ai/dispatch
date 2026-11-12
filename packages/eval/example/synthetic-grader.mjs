// A synthetic grader for the atlas example: a model provider that answers every grading prompt by fixed rules, so the
// example runs without a model, a network or a credential. Bind it in the host configuration:
//
//   "modelProviders": [{ "module": "/ABSOLUTE/PATH/synthetic-grader.mjs", "export": "syntheticGrader" }]
//
// It is not a grader for real work. It only recognises the example's own prompts.
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";

const attributes = ["river", "founded", "population", "mayor"];

/** The JSON a prompt carries after its one-line instruction. */
function payload(context) {
  const last = context.messages.findLast(message => message.role === "user");
  const text = typeof last.content === "string" ? last.content : last.content.filter(part => part.type === "text").map(part => part.text).join("\n");
  return JSON.parse(text.slice(text.indexOf("{")));
}

function extract(request) {
  const question = request.question.toLowerCase();
  const parts = attributes.filter(attribute => question.includes(attribute))
    .sort((a, b) => question.indexOf(a) - question.indexOf(b))
    .map((attribute, index) => ({ id: `S${index + 1}`, attribute, text: `the ${attribute} of ${request.place}`, source_quote: attribute }));
  return { place: request.place, parts };
}

function judge({ requirements, evidence }) {
  const parts = requirements.parts.map(part => {
    const recorded = evidence.reference[part.attribute];
    if (recorded === undefined) return { id: part.id, value: "unsupported", evidence: `reference has no ${part.attribute}` };
    const stated = String(evidence.answer).includes(String(recorded));
    return { id: part.id, value: stated ? "met" : "not_met",
      evidence: `reference.${part.attribute} = ${recorded}; the answer ${stated ? "states it" : "does not state it"}` };
  });
  const count = value => parts.filter(part => part.value === value).length;
  return { parts, summary: `${count("met")} met, ${count("not_met")} not met, ${count("unsupported")} not settled by the atlas.` };
}

export function syntheticGrader() {
  const faux = fauxProvider({ provider: "synthetic", models: [{ id: "atlas-rules", reasoning: false, input: ["text"] }] });
  const answer = context => {
    const value = payload(context);
    return fauxAssistantMessage("```json\n" + JSON.stringify(value.requirements ? judge(value) : extract(value), null, 2) + "\n```");
  };
  // The provider answers from a queue; each request brings its own answer.
  const stream = (model, context, options) => { faux.appendResponses([answer]); return faux.provider.stream(model, context, options); };
  return { ...faux.provider, stream, streamSimple: stream };
}
