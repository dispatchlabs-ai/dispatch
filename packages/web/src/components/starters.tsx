import { useState } from "react";
import type { ModelOption, ThinkingLevel } from "../shared/contracts";
import { Button, Field, Select } from "./ui";

/** The parent owns loading, errors and the existing archive preview/retry state. */
export function StarterPicker({ models, disabled, onPreview }: {
  models: ModelOption[];
  disabled: boolean;
  onPreview: (selection: { provider: string; modelId: string; thinkingLevel: ThinkingLevel }) => void;
}) {
  const [modelKey, setModelKey] = useState("");
  const [thinking, setThinking] = useState<ThinkingLevel | "">("");
  const model = models.find(item => JSON.stringify([item.provider, item.id]) === modelKey);
  const validThinking = model?.thinkingLevels.includes(thinking as ThinkingLevel) ? thinking as ThinkingLevel : undefined;
  return <section className="bundle-content" aria-label="Starter agent">
    <strong>Developer starter</strong>
    <span>Files and commands. No skills or connections.</span>
    <Field label="Model">{props => <Select {...props} value={modelKey} disabled={disabled} onChange={event => {
      setModelKey(event.target.value); setThinking("");
    }}>
      <option value="">Choose a model</option>
      {models.map(item => <option key={JSON.stringify([item.provider, item.id])} value={JSON.stringify([item.provider, item.id])}>{item.name} ({item.provider})</option>)}
    </Select>}</Field>
    <Field label="Thinking">{props => <Select {...props} value={validThinking ?? ""} disabled={disabled || !model} onChange={event => setThinking(event.target.value as ThinkingLevel)}>
      <option value="">Choose thinking level</option>
      {model?.thinkingLevels.map(level => <option key={level} value={level}>{level}</option>)}
    </Select>}</Field>
    <Button disabled={disabled || !model || !validThinking} onClick={() => {
      if (model && validThinking) onPreview({ provider: model.provider, modelId: model.id, thinkingLevel: validThinking });
    }}>Preview starter</Button>
  </section>;
}
