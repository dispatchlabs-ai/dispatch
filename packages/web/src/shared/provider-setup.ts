export type SetupProviderId = "openai" | "openai-api" | "openai-codex" | "anthropic" | "fireworks" | "google" | "xai" | "mistral" | "meta";
export type ProviderStatus = {
  id: SetupProviderId; name: string; methods: ("oauth" | "api_key")[];
  state: "not_connected" | "key_saved" | "authorized" | "reconnect_required" | "externally_managed" | "unavailable";
  type?: "oauth" | "api_key"; account?: string;
  revision: string; models: { id: string; name: string }[];
};
export type ProviderLogin = {
  id: string; providerId: SetupProviderId;
  state: "working" | "awaiting_input" | "saved" | "failed" | "cancelled";
  message?: string; authorizationUrl?: string; userCode?: string;
  prompt?: { id: string; type: "text" | "secret" | "select" | "manual_code"; message: string; placeholder?: string; options?: { id: string; label: string }[] };
};
