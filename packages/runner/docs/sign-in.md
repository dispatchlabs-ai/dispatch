# Sign in and choose a model

The starter uses `openai/gpt-6.1-sol`. Sign in once on the computer that runs the
host, then use the same agents from the terminal, browser or other clients.
Clients do not need model credentials.

Available in **v0.19.0 and later**. Install the matching release archives using the
[quickstart](../../../README.md#quickstart) or [two-agent setup](create-agents.md).

For the current source's interactive provider/model setup and managed Apple local
server, see [Connect providers and choose models](providers.md). That feature is
unreleased; the commands below work with v0.19.0.

## ChatGPT subscription

From your agents application directory:

```sh
npx dispatch login openai
npx dispatch serve
```

Choose your account in the browser and approve Dispatch's use of your ChatGPT
plan. The terminal reports `Signed in to openai` when the credential has been
saved. No OpenAI API key is needed. In another terminal, run `npx dispatch chat`.
For the two-agent application, use `npm start` and `npm run chat` instead.

If the same email belongs to a work workspace and a personal account, select the
account whose plan you intend to use. A remembered SSO login may select work;
choose **Use another account → Continue with email**, sign in, then choose
**Personal account** for your personal subscription. Organization policy may
restrict external app access independently of your personal plan.

This uses Pi's native **Sign in with ChatGPT** flow and OpenAI's public Responses
API. Access and usage limits depend on the selected account and plan. It does
not import ChatGPT conversation history. See OpenAI's
[local open-source app support](https://developers.openai.com/siwc/token-sharing-open-source)
and [models and inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference).

For a host with `host.json`, replace the environment-only binding with:

```json
{
  "modelProviders": [{
    "module": "@dispatch/runner/local-provider",
    "export": "localProvider",
    "args": ["openai"]
  }]
}
```

Keep the other host settings. The no-config `dispatch serve` launcher selects
this binding automatically. Existing `environmentProvider` bindings deliberately
remain API-key-only; existing application-owned gateways are unchanged.

## Claude subscription or API account

Use a current Claude model in `agent.md`, for example:

```yaml
model: { provider: anthropic, id: claude-sonnet-5-5, thinking: low }
```

Change the host binding's `args` to `["anthropic"]` too. For the supported
third-party API path, supply `ANTHROPIC_API_KEY` in the host environment.
Eligible Claude Max, Ultra and Team subscribers can link a Console organization
for included API credits; a subscription is not itself an API key. See
[Anthropic's subscriber API-credit instructions](https://platform.claude.com/docs/en/about-claude/api-credits-for-subscribers).

Pi 1.5.2 also implements Claude OAuth, exposed by `npx dispatch login anthropic`.
A live subscription sign-in and tool call were verified during the new provider
setup work; see the dated [verification record](../../../docs/qualification.md).
That implementation does not establish permission to use a subscription in a
third-party app: Anthropic's current
[credential-use policy](https://code.claude.com/docs/en/legal-and-compliance#authentication-and-credential-use)
restricts that use. Dispatch does not promise that every Claude subscription
can authenticate or pay for third-party requests. Check the provider's current
rules and your account eligibility.

Advanced hosts can also bind the separately packaged experimental
[Pi Claude Code provider](https://github.com/earendil-works/pi-claude-code), using
the official CLI's own login and billing rules. Dispatch retains that optional
Nix integration; it is not installed by the npm starter and was not used in the native subscription check.

## API keys

For the default OpenAI model, set `OPENAI_API_KEY` in the host terminal using
your secret manager, then start the host. Use `ANTHROPIC_API_KEY` for Anthropic.
Creating `.env` alone does not load it. Keep keys out of agent definitions,
`host.json`, shell command arguments and Git.

`npx dispatch login openai --api-key` (or `anthropic`)
offers hidden terminal input for a saved key. For OS keychain or vault-helper
integration in a custom host, see [host-owned API credentials](credentials.md).

## Accounts, storage and recovery

- `npx dispatch auth` lists saved provider IDs and authentication types. It does
  not print tokens, refresh them or validate account/model access.
- `npx dispatch logout openai` removes the local credential. It does not revoke
  provider-side access, erase conversations or unset environment keys. Revoke
  access with the provider if needed.
- Saved credentials take precedence over the provider's environment key. A
  failed saved sign-in produces an error rather than silently changing accounts.
  Sign in again, or log out to return to environment-key authentication.
- Run login as the same OS user as the host, on that host's computer. For SSH,
  use the displayed browser link and paste the final callback URL when asked.
  `--no-browser` suppresses automatic browser opening. Ctrl-C cancels sign-in.
  OpenAI's callback uses local port 1455; finish other sign-in flows using that
  port before retrying.
- Restart the host after changing accounts or its model bindings. Pi owns token
  refresh during requests; Dispatch persists rotated tokens atomically under a
  cross-process lock. Cancelling a turn does not discard a completed refresh.

The local sign-in store is `~/.config/dispatch/auth.json`, or
`$XDG_CONFIG_HOME/dispatch/auth.json`. Windows uses
`%APPDATA%\Dispatch\auth.json`. It contains credentials, protected by private
file permissions (0700 directory, 0600 file on POSIX); it is not OS-keychain
storage. `DISPATCH_AUTH_DIR` selects another private directory for both login
and host processes. Keep it outside your agents repository and backups shared
with others. One OS-user store is shared by local Dispatch applications unless
you explicitly select separate directories. Never copy another app's rotating
OAuth credentials into a second independently refreshing store.
