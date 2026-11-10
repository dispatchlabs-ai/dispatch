import { getSupportedThinkingLevels } from '@earendil-works/pi-ai/models';
import { stream as piStream } from '@earendil-works/pi-ai/api/pi-messages';
import { AssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';

export type ModelChoice = { provider: string; providerName: string; id: string; name: string; levels: string[]; images?: boolean; hidden?: boolean };
export type GatewayAliases = Record<string, string | { target: string; hidden?: boolean }>;
export type GatewayAuthorization = (options?: { forceRefresh?: boolean; signal?: AbortSignal }) => Promise<string>;
const filtered = (options: any) => Object.fromEntries(Object.entries(options ?? {}).filter(([key, value]) =>
  value !== undefined && !['model','toolExecution','apiKey','headers','env','signal','fetch','onPayload','onResponse','onProviderStreamEvent','identity','telemetry','telemetryContext','transformHeaders'].includes(key)));

// A gateway request whose stream shows no progress for this long is abandoned so Pi's retry policy sends a fresh one.
// Observed on the Codex route: stalled requests ended only at the gateway's 900 s upstream limit with
// provider_connection_error, and their retries completed in seconds. The slowest healthy whole responses observed
// were 55 s (low), 90 s (medium), 228 s (high) and 418 s (max) thinking, so each limit stays well above any
// healthy silence. Empty deltas do not count as progress. xhigh/max and an unstated level keep the gateway's own limit.
const STALL_SECONDS: Record<string, number> = { minimal: 180, low: 180, medium: 300, high: 600 };
export const stallMs = (reasoning?: string) => (reasoning === undefined ? 0 : STALL_SECONDS[reasoning] ?? 0) * 1000;

export async function refreshGatewayModels(origin: string, models: any, key?: string | GatewayAuthorization, aliases: GatewayAliases = {}, options: { signal?: AbortSignal } = {}): Promise<ModelChoice[]> {
  const gatewayOrigin = new URL(origin).origin;
  const authorizedFetch: typeof fetch = async (input, init) => {
    const signal = init?.signal !== undefined ? init.signal : input instanceof Request ? input.signal : undefined;
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.origin !== gatewayOrigin || !url.pathname.startsWith('/v1/')) throw new Error('Gateway transport cannot access another origin or API path.');
    const send = async (forceRefresh: boolean) => {
      request.signal.throwIfAborted();
      const token = typeof key === 'function' ? await key({ forceRefresh, signal: request.signal }) : key;
      request.signal.throwIfAborted();
      if (typeof key === 'function' && !token) throw new Error('Gateway authorization returned an empty token.');
      const headers = new Headers(request.headers);
      if (token) headers.set('authorization', `Bearer ${token}`);
      return fetch(request.clone(), { headers, redirect: 'error', signal });
    };
    const response = await send(false);
    // Gateway authentication failures precede admission; never replay accepted work.
    if (response.status !== 401 || typeof key !== 'function') return response;
    await response.body?.cancel();
    return send(true);
  };
  const response = await authorizedFetch(`${origin}/v1/catalog`, { signal: options.signal });
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
      const models = [...new Map<string, any>(members.flatMap((c: any) => c.models
        .filter((model: any) => !model.type || model.type === 'chat')
        .map((model: any) => [model.id, model]))).values()];
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
      const limit = stallMs(options?.reasoning);
      const stall = new AbortController();
      const signal = options?.signal ? AbortSignal.any([options.signal, stall.signal]) : stall.signal;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let ended = false;
      const fail = (errorMessage: string) => {
        if (ended) return;
        ended = true;
        output.push({ type: 'error', reason: 'error', error: {
          role: 'assistant', content: [], api: model.api, provider, model: model.id,
          timestamp: Date.now(), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: 'error', errorMessage,
        } });
      };
      // "timed out" is retryable in Pi; the caller's own abort is never relabelled as a stall.
      const stalled = () => `Model stream stalled: no progress for ${limit / 1000} s at ${options?.reasoning} thinking; the request timed out and is retried.`;
      const arm = () => {
        if (!limit) return;
        clearTimeout(timer);
        timer = setTimeout(() => { if (!options?.signal?.aborted) stall.abort(new Error(stalled())); }, limit);
      };
      void (async () => {
        let terminal: any;
        arm();
        const responses = group ? await import('@earendil-works/pi-ai/api/openai-responses') : undefined;
        const upstream = responses ? (operation === 'streamSimple' ? responses.streamSimple : responses.stream)(
          { ...model, api: 'openai-responses', baseUrl: `${origin}/v1` }, transcript, {
            ...options, signal, apiKey: typeof key === 'string' ? key : 'native-keychain',
            fetch: authorizedFetch,
            onPayload: (payload: any) => ({ ...payload, model: `${group}/${model.id}` }),
          }) : piStream({ ...model, api: 'pi-messages', baseUrl: `${origin}/v1/connections/${connection.id}` }, transcript, {
          apiKey: typeof key === 'string' ? key : 'native-keychain', signal, fetch: authorizedFetch,
          onPayload: () => ({ model: model.id, context: transcript, operation, options: filtered(options) }),
          onProviderStreamEvent: (event: any) => { if (event.message) terminal = event.message; },
        });
        for await (const event of upstream) {
          if (stall.signal.aborted) break;
          // An empty delta is not progress: a stalled upstream was observed sending empty tool-call argument deltas for
          // 15 minutes (about 10 MB) without changing the response.
          if (!(event.type.endsWith('_delta') && !(event as any).delta)) arm();
          const message = event.type === 'done' ? event.message : event.type === 'error' ? event.error : event.partial;
          if ((event.type === 'done' || event.type === 'error') && terminal) Object.assign(message, terminal);
          message.api = model.api; message.provider = provider;
          if (event.type === 'done' || event.type === 'error') ended = true;
          output.push(event);
        }
        if (stall.signal.aborted) fail(stalled());
      })().catch(error => fail(stall.signal.aborted ? stalled() : String(error)))
        .finally(() => clearTimeout(timer));
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
