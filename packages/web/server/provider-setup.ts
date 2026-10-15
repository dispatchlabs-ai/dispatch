import { createHmac, randomBytes, randomUUID, createHash } from "node:crypto";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { AuthPrompt, CredentialStore } from "@earendil-works/pi-ai";
import type { AuthPrincipal } from "./auth.js";
import type { ProviderLogin, ProviderStatus, SetupProviderId } from "../src/shared/provider-setup.js";

const definitions = [
  { id: "openai", name: "OpenAI", methods: ["oauth", "api_key"] },
  { id: "openai-api", name: "OpenAI API", methods: ["api_key"] },
  { id: "openai-codex", name: "Codex images", methods: ["oauth"] },
  { id: "anthropic", name: "Anthropic API", methods: ["api_key"] },
  { id: "fireworks", name: "Fireworks", methods: ["api_key"] },
  { id: "google", name: "Google Gemini API", methods: ["api_key"] },
  { id: "xai", name: "xAI API", methods: ["api_key"] },
  { id: "mistral", name: "Mistral API", methods: ["api_key"] },
  { id: "meta", name: "Meta API", methods: ["api_key"] },
] as const;
export class ProviderSetupError extends Error {
  constructor(readonly status: 400 | 404 | 409 | 503, message: string) { super(message); }
}
type Attempt = {
  view: ProviderLogin; sessionId: string; stopped: boolean; expiresAt: number;
  pending?: { id: string; resolve: (value: string) => void; reject: () => void; options?: readonly { id: string }[] };
  done: Promise<void>; timer: ReturnType<typeof setTimeout>;
};

/** Ephemeral browser interaction only. Pi owns exchange, refresh and credential writes. */
export class ProviderSetup {
  private readonly revisionKey = randomBytes(32);
  private attempts = new Map<string, Attempt>();
  private active?: Attempt;
  private accepting = true;
  private mutations: Promise<void> = Promise.resolve();
  private mutate<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutations.then(operation);
    this.mutations = result.then(() => {}, () => {});
    return result;
  }
  constructor(private readonly models: ModelRuntime, private readonly credentials: CredentialStore & { inspect?(id: string): Promise<{ pending: boolean }> },
    private readonly installationId: string, private readonly isSessionValid: (id: string) => Promise<boolean>,
    private readonly runBackground: (operation: () => Promise<void>) => Promise<void> = operation => operation()) {}

  private definition(id: SetupProviderId) {
    const definition = definitions.find(value => value.id === id);
    if (!definition || !this.models.getProvider(id)) throw new ProviderSetupError(404, "Provider is not available.");
    return definition;
  }
  private revision(value: unknown) { return createHmac("sha256", this.revisionKey).update(JSON.stringify(value)).digest("base64url"); }
  private async status(id: SetupProviderId): Promise<ProviderStatus> {
    const definition = this.definition(id);
    let credential;
    let interrupted = false, unavailable = false;
    try {
      interrupted = (await this.credentials.inspect?.(id))?.pending ?? false;
      if (!interrupted) credential = await this.credentials.read(id);
    } catch { unavailable = true; }
    let external = false;
    if (!credential && !interrupted && !unavailable) {
      try { external = !!await this.models.checkAuth(id); }
      catch { unavailable = true; }
    }
    const state = unavailable ? "unavailable" : interrupted ? "reconnect_required" : credential?.type === "api_key" ? "key_saved" : credential ? "authorized" : external ? "externally_managed" : "not_connected";
    // Only allowlisted, provider-returned metadata; never decode tokens for an identity.
    const account = credential?.type === "oauth" && typeof credential.accountId === "string" ? credential.accountId.slice(0, 200) : undefined;
    return { id, name: definition.name, methods: [...definition.methods], state, type: credential?.type, account,
      revision: this.revision([id, interrupted, unavailable, external, credential ?? null]),
      models: (id === "openai-codex" ? [] : this.models.getModels(id)).map(model => ({ id: model.id, name: model.name })) };
  }
  async list(principal?: AuthPrincipal) {
    const values: ProviderStatus[] = [];
    for (const definition of definitions) {
      if (!this.models.getProvider(definition.id)) continue;
      const status = await this.status(definition.id);
      values.push(status);
    }
    return { providers: values, attempt: principal && this.active?.sessionId === principal.sessionId ? this.snapshot(this.active) : null };
  }
  private async assertRevision(id: SetupProviderId, revision: string) {
    if (!this.accepting) throw new ProviderSetupError(503, "Provider setup is shutting down.");
    if (this.active) throw new ProviderSetupError(409, "Finish or cancel the current provider setup first.");
    const status = await this.status(id);
    if (!this.accepting) throw new ProviderSetupError(503, "Provider setup is shutting down.");
    if (status.state === "unavailable") throw new ProviderSetupError(503, "Credential storage is unavailable. Contact your operator.");
    if (status.revision !== revision) throw new ProviderSetupError(409, "Provider changed. Reload before continuing.");
    return status;
  }
  disconnect(id: SetupProviderId, revision: string) {
    return this.mutate(async () => {
      await this.assertRevision(id, revision);
      await this.models.logout(id);
      return this.list();
    });
  }
  start(principal: AuthPrincipal, id: SetupProviderId, type: "oauth" | "api_key", revision: string) {
    return this.mutate(() => this.startAdmitted(principal, id, type, revision));
  }
  private async startAdmitted(principal: AuthPrincipal, id: SetupProviderId, type: "oauth" | "api_key", revision: string) {
    if (!(this.definition(id).methods as readonly string[]).includes(type)) throw new ProviderSetupError(400, "Choose a supported connection method.");
    const status = await this.assertRevision(id, revision);
    if (status.state === "reconnect_required") throw new ProviderSetupError(409, "Disconnect the uncertain credential before reconnecting. If storage is unavailable, contact your operator.");
    for (const [key, attempt] of this.attempts) if (attempt.expiresAt < Date.now() && attempt !== this.active) this.attempts.delete(key);
    if (this.attempts.size >= 20) throw new ProviderSetupError(503, "Too many recent setup attempts. Try again shortly.");
    const attempt: Attempt = { view: { id: randomUUID(), providerId: id, state: "working" }, sessionId: principal.sessionId,
      expiresAt: Date.now() + 10 * 60_000, stopped: false, done: Promise.resolve(), timer: setTimeout(() => {}, 0) };
    clearTimeout(attempt.timer);
    this.active = attempt;
    this.attempts.set(attempt.view.id, attempt);
    attempt.timer = setInterval(() => {
      void this.revalidate(attempt);
    }, 5_000);
    attempt.timer.unref();
    attempt.done = this.runBackground(() => this.login(attempt, type)).catch(() => {
      clearTimeout(attempt.timer);
      attempt.view = { id: attempt.view.id, providerId: id, state: "failed", message: "Provider setup is unavailable. Try again after reopening the application." };
      if (this.active === attempt) this.active = undefined;
    });
    return this.snapshot(attempt);
  }
  private snapshot(attempt: Attempt): ProviderLogin { return structuredClone(attempt.view); }
  private async login(attempt: Attempt, type: "oauth" | "api_key") {
    try {
      if (attempt.stopped) throw new Error("Setup cancelled.");
      await this.models.login(attempt.view.providerId, type, {
        // Do not use Pi's outer signal: cancellation during exchange can discard issued credentials.
        prompt: input => this.prompt(attempt, input),
        notify: event => {
          if (attempt.stopped) return;
          if (event.type === "auth_url" && new URL(event.url).protocol === "https:") attempt.view.authorizationUrl = event.url;
          if (event.type === "device_code" && new URL(event.verificationUri).protocol === "https:") {
            attempt.view.authorizationUrl = event.verificationUri; attempt.view.userCode = event.userCode;
          }
        },
      }, { getDeviceId: () => {
        const bytes = createHash("sha256").update(`dispatch-provider:${this.installationId}`).digest().subarray(0, 16);
        bytes[6] = (bytes[6]! & 15) | 0x50; bytes[8] = (bytes[8]! & 63) | 0x80;
        const hex = bytes.toString("hex"); return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
      } });
      attempt.view = { id: attempt.view.id, providerId: attempt.view.providerId, state: "saved" };
    } catch {
      // Provider failures and synchronization errors can carry credentials or response bodies.
      attempt.view = { id: attempt.view.id, providerId: attempt.view.providerId, state: attempt.stopped ? "cancelled" : "failed",
        message: attempt.stopped ? "Setup cancelled." : "Setup could not be confirmed. Reload provider status before retrying." };
    } finally {
      clearTimeout(attempt.timer);
      attempt.pending?.reject(); attempt.pending = undefined;
      if (this.active === attempt) this.active = undefined;
    }
  }
  private async prompt(attempt: Attempt, input: AuthPrompt): Promise<string> {
    if (attempt.stopped || !await this.isSessionValid(attempt.sessionId)) throw new Error("Setup cancelled.");
    input.signal?.throwIfAborted();
    const id = randomUUID();
    attempt.view.state = "awaiting_input";
    attempt.view.prompt = { id, type: input.type, message: input.message,
      ...("placeholder" in input ? { placeholder: input.placeholder } : {}),
      ...(input.type === "select" ? { options: input.options.map(option => ({ id: option.id, label: option.label })) } : {}) };
    return new Promise<string>((resolve, reject) => {
      const clear = () => {
        input.signal?.removeEventListener("abort", abort);
        if (attempt.pending?.id === id) { attempt.pending = undefined; attempt.view.prompt = undefined; attempt.view.state = "working"; }
      };
      const abort = () => { clear(); reject(new Error("Setup prompt cancelled.")); };
      attempt.pending = { id, options: input.type === "select" ? input.options : undefined, resolve: value => { clear(); resolve(value); }, reject: abort };
      input.signal?.addEventListener("abort", abort, { once: true });
      if (input.signal?.aborted || attempt.stopped) abort();
    });
  }
  private find(principal: AuthPrincipal, id: string) {
    const attempt = this.attempts.get(id);
    if (!attempt || attempt.sessionId !== principal.sessionId) throw new ProviderSetupError(404, "Setup attempt not found. Start again.");
    return attempt;
  }
  async get(principal: AuthPrincipal, id: string) {
    const attempt = this.find(principal, id);
    if (!await this.isSessionValid(attempt.sessionId)) this.stop(attempt);
    return this.snapshot(attempt);
  }
  answer(principal: AuthPrincipal, id: string, promptId: string, value: string) {
    const attempt = this.find(principal, id), pending = attempt.pending;
    if (!pending || pending.id !== promptId || attempt.stopped) throw new ProviderSetupError(409, "This setup step has changed. Reload it.");
    if (pending.options && !pending.options.some(option => option.id === value)) throw new ProviderSetupError(400, "Choose an available option.");
    pending.resolve(value);
    return this.snapshot(attempt);
  }
  private async revalidate(attempt: Attempt) {
    try {
      if (Date.now() >= attempt.expiresAt || !await this.isSessionValid(attempt.sessionId)) this.stop(attempt);
    } catch { this.stop(attempt); }
  }
  private stop(attempt: Attempt) { attempt.stopped = true; attempt.pending?.reject(); }
  async cancel(principal: AuthPrincipal, id: string) {
    const attempt = this.find(principal, id); this.stop(attempt);
    await attempt.done;
    return this.snapshot(attempt);
  }
  resume() { this.accepting = true; }
  async quiesce() {
    this.accepting = false;
    await this.mutations;
    for (const attempt of this.attempts.values()) this.stop(attempt);
    await Promise.all([...this.attempts.values()].map(attempt => attempt.done));
  }
  async close() {
    await this.quiesce();
    this.revisionKey.fill(0);
  }
}
