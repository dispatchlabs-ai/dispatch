// A local interactive demonstration, never a model/inference qualification claim.
import { fauxProvider, fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux';
export function exampleProvider() {
  const faux = fauxProvider({ provider: 'example', models: [{ id: 'example' }], tokensPerSecond: 8 });
  const reply = context => {
    faux.appendResponses([reply]);
    const message = context.messages.filter(message => message.role === 'user').at(-1);
    const text = typeof message?.content === 'string' ? message.content : message?.content?.filter(part => part.type === 'text').map(part => part.text).join('\n');
    return fauxAssistantMessage(`Synthetic native reply: ${text ?? 'Hello'}. This response streams slowly so you can send a follow-up or stop it.`);
  };
  faux.setResponses([reply]);
  return faux.provider;
}
