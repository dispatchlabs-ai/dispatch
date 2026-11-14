# Sign in and choose a model

The starter uses `openai/gpt-6.1-sol`. Sign in once on the computer that runs the
host, then use the same agents from the terminal, browser or other clients.
Clients do not need model credentials.

**Availability:** `dispatch login`, `dispatch auth`, `dispatch logout` and
`localProvider` are implemented on `main`, awaiting a package release. The
published **0.18.0** archives support API keys and custom host providers; they do
not contain these new commands. Use the source preview below to try sign-in now.

## ChatGPT subscription

With the source preview installed in your agents application:

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
That implementation does not establish permission to use a subscription in a
third-party app: Anthropic's current
[credential-use policy](https://code.claude.com/docs/en/legal-and-compliance#authentication-and-credential-use)
restricts that use. Dispatch does not promise that every Claude subscription
can authenticate or pay for third-party requests. Check the provider's current
rules and your account eligibility.

Advanced hosts can also bind the separately packaged experimental
[Pi Claude Code provider](https://github.com/earendil-works/pi-claude-code), using
the official CLI's own login and billing rules. Dispatch retains that optional
Nix integration; it is not installed by the npm starter or newly qualified here.

## API keys

API-key access works in both the released archives and the source preview.
For the default OpenAI model, set `OPENAI_API_KEY` in the host terminal using
your secret manager, then start the host. Use `ANTHROPIC_API_KEY` for Anthropic.
Creating `.env` alone does not load it. Keep keys out of agent definitions,
`host.json`, shell command arguments and Git.

In the source preview, `npx dispatch login openai --api-key` (or `anthropic`)
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

## Try the source preview

Use Node 24.22.1 or newer. This is an optional development install until the next
versioned archive includes sign-in; the normal released install needs no clone.

```sh
git clone https://github.com/dispatchlabs-ai/dispatch.git dispatch-source
cd dispatch-source
npm ci
npm run build --workspace @dispatch/runner
npm pack --workspace @dispatch/runner --pack-destination ..
```

In your agents application, install the resulting archive, using its absolute
path:

```sh
npm install /absolute/path/to/dispatch-runner-0.18.0.tgz
```

The source version remains 0.18.0 until release preparation. This locally built
archive contains unreleased changes; it is not the published 0.18.0 archive.
Keep your own agent files and host settings. Follow the
[two-agent setup](create-agents.md), changing its provider binding to
`localProvider` as shown above, then sign in. Web and MCP clients continue using
the same host/client contract.
