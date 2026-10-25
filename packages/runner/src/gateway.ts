import { getSupportedThinkingLevels } from '@earendil-works/pi-ai/models';
import { stream as piStream } from '@earendil-works/pi-ai/api/pi-messages';
import { stream as responsesStream, streamSimple as responsesSimple } from '@earendil-works/pi-ai/api/openai-responses';
import { AssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';

export type ModelChoice = { provider: string; providerName: string; id: string; name: string; levels: string[]; images?: boolean; hidden?: boolean };
export type GatewayAliases = Record<string, string | { target: string; hidden?: boolean }>;
const filtered = (options: any) => Object.fromEntries(Object.entries(options ?? {}).filter(([key, value]) =>
  value !== undefined && !['model','toolExecution','apiKey','headers','env','signal','fetch','onPayload','onResponse','onProviderStreamEvent','identity','telemetry','telemetryContext','transformHeaders'].includes(key)));

export async function refreshGatewayModels(origin: string, models: any, key?: string, aliases: GatewayAliases = {}): Promise<ModelChoice[]> {
  const response = await fetch(`${origin}/v1/catalog`, { redirect: 'error', ...(key ? { headers: { authorization: `Bearer ${key}` } } : {}) });
  if (!response.ok) throw new Error(`Model access: HTTP ${response.status}`);
  const catalog = await response.json();
  if (catalog.version !== 1 || !Array.isArray(catalog.connections)) throw new Error('Unsupported gateway catalog.');
  const targetOf = (value: GatewayAliases[string]) => typeof value === 'string' ? value : value.target;
  const groups = new Set(Object.values(aliases).map(targetOf).filter(target => target.startsWith('provider:')).map(target => target.slice(9)));
  const bindings: { provider: string; connection: any; name: string; group?: string; hidden?: boolean }[] =
    catalog.connections.filter((c: any) => !Object.hasOwn(aliases, c.id) && !groups.has(c.provider))
      .map((connection: any) => ({ provider: connection.id, connection, name: connection.name }));
  for (const [provider, value] of Object.entries(aliases)) {
    const target = targetOf(value), hidden = typeof value !== 'string' && value.hidden === true;
    if (target.startsWith('provider:')) {
      const group = target.slice(9);
      const members = catalog.connections.filter((c: any) => c.provider === group);
      if (!members.length) throw new Error(`Model alias ${provider} requires gateway provider ${group}.`);
      const models = [...new Map<string, any>(members.flatMap((c: any) => c.models.map((model: any) => [model.id, model]))).values()];
      bindings.push({ provider, group, hidden, connection: { models }, name: hidden ? `${provider} (earlier selection)` : `${group} pool` });
      continue;
    }
    const connection = catalog.connections.find((c: any) => c.id === target);
    if (!connection) throw new Error(`Model alias ${provider} requires gateway connection ${target}.`);
    bindings.push({ provider, connection, hidden, name: `${provider} via ${connection.name}` });
  }
  const result: ModelChoice[] = [];
  for (const { provider, connection, name, group, hidden } of bindings) {
    const choices = connection.models.filter((m: any) => !m.type || m.type === 'chat');
    result.push(...choices.map((m: any) => ({ provider, providerName: name,
      id: m.id, name: m.name ?? m.id, levels: getSupportedThinkingLevels(m), images: m.input?.includes('image') === true, ...(hidden ? { hidden } : {}) })));
    const stream = (operation: string) => (model: any, transcript: any, options: any) => {
      const output = new AssistantMessageEventStream();
      void (async () => {
        let terminal: any;
        const upstream = group ? (operation === 'streamSimple' ? responsesSimple : responsesStream)(
          { ...model, api: 'openai-responses', baseUrl: `${origin}/v1` }, transcript, {
            ...options, apiKey: key ?? 'native-keychain',
            fetch: (input: any, init: any) => fetch(input, { ...init, redirect: 'error' }),
            onPayload: (payload: any) => ({ ...payload, model: `${group}/${model.id}` }),
          }) : piStream({ ...model, api: 'pi-messages', baseUrl: `${origin}/v1/connections/${connection.id}` }, transcript, {
          apiKey: key ?? 'native-keychain', signal: options?.signal,
          onPayload: () => ({ model: model.id, context: transcript, operation, options: filtered(options) }),
          onProviderStreamEvent: (event: any) => { if (event.message) terminal = event.message; },
        });
        for await (const event of upstream) {
          const message = event.type === 'done' ? event.message : event.type === 'error' ? event.error : event.partial;
          if ((event.type === 'done' || event.type === 'error') && terminal) Object.assign(message, terminal);
          message.api = model.api; message.provider = provider;
          output.push(event);
        }
      })().catch(error => {
        output.push({ type: 'error', reason: 'error', error: {
          role: 'assistant', content: [], api: model.api, provider, model: model.id,
          timestamp: Date.now(), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: 'error', errorMessage: String(error),
        } });
      });
      return output;
    };
    models.setProvider({ id: provider, name,
      auth: { apiKey: { name: 'Gateway', resolve: async () => ({ auth: { apiKey: 'native-keychain' }, source: 'Gateway credential' }) } },
      getModels: () => choices.map((m: any) => ({ ...m, provider })),
      stream: stream('stream'), streamSimple: stream('streamSimple'),
    });
  }
  return result;
}
