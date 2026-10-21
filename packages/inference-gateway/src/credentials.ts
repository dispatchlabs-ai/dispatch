import { GetSecretValueCommand, PutSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import type { AuthOperationOptions, Credential, CredentialStore } from "@earendil-works/pi-ai";
import { z } from "zod";

const credentialSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("api_key"), key: z.string().optional(), env: z.record(z.string(), z.string()).optional() }).strict(),
  z.object({ type: z.literal("oauth"), access: z.string(), refresh: z.string(), expires: z.number() }).passthrough(),
]);

/** One gateway process owns each OAuth secret. Deployment must stop the old writer before starting its replacement. */
export class SecretsCredentialStore implements CredentialStore {
  private tail: Promise<unknown> = Promise.resolve();
  private cached?: { value: Credential | undefined; until: number };

  constructor(private readonly client: SecretsManagerClient, private readonly secretId: string, private readonly provider: string, private readonly assertOwner?: () => Promise<void>, private readonly pending?: Set<Promise<unknown>>) {}

  private async load(signal?: AbortSignal): Promise<Credential | undefined> {
    const result = await this.client.send(new GetSecretValueCommand({ SecretId: this.secretId }), { abortSignal: signal });
    const value: unknown = JSON.parse(result.SecretString ?? "null");
    const credential = value === null ? undefined : credentialSchema.parse(value);
    this.cached = { value: credential, until: Date.now() + 60_000 };
    return credential;
  }

  async read(provider: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
    if (provider !== this.provider) return undefined;
    await this.tail;
    options?.signal?.throwIfAborted();
    return this.cached && this.cached.until > Date.now() ? this.cached.value : this.load(options?.signal);
  }

  async list(options?: AuthOperationOptions) {
    const credential = await this.read(this.provider, options);
    return credential ? [{ providerId: this.provider, type: credential.type }] : [];
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.tail.then(operation);
    this.pending?.add(pending);
    this.tail = pending.then(() => { this.pending?.delete(pending); }, () => { this.pending?.delete(pending); });
    return pending;
  }

  modify(provider: string, fn: (current: Credential | undefined) => Promise<Credential | undefined>, options?: AuthOperationOptions): Promise<Credential | undefined> {
    if (provider !== this.provider) return Promise.reject(new Error("Unknown credential provider"));
    return this.serialize(async () => {
      await this.assertOwner?.();
      const current = await this.load(options?.signal);
      const next = await fn(current);
      if (next !== undefined && JSON.stringify(next) !== JSON.stringify(current)) {
        // Persist a rotated credential even if the request was cancelled after refresh.
        await this.client.send(new PutSecretValueCommand({ SecretId: this.secretId, SecretString: JSON.stringify(credentialSchema.parse(next)) }));
        this.cached = { value: next, until: Date.now() + 60_000 };
      }
      return next ?? current;
    });
  }

  async delete(provider: string, options?: AuthOperationOptions): Promise<void> {
    if (provider !== this.provider) throw new Error("Unknown credential provider");
    await this.serialize(async () => {
      await this.assertOwner?.();
      await this.client.send(new PutSecretValueCommand({ SecretId: this.secretId, SecretString: "null" }), { abortSignal: options?.signal });
      this.cached = undefined;
    });
  }
}
