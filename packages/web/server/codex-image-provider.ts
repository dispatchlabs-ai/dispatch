import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";

/** Codex owns login/refresh; carry its saved account selection into image requests. */
export function codexImageProvider() {
  const provider = openaiCodexProvider();
  const oauth = provider.auth.oauth!;
  return {
    ...provider,
    auth: {
      ...provider.auth,
      oauth: {
        ...oauth,
        async toAuth(credential: Parameters<typeof oauth.toAuth>[0]) {
          const auth = await oauth.toAuth(credential);
          if (typeof credential.accountId !== "string" || !credential.accountId)
            throw new Error("Codex credential is missing its account selection. Reconnect Codex images.");
          return { ...auth, headers: { ...auth.headers, "chatgpt-account-id": credential.accountId } };
        },
      },
    },
  };
}
