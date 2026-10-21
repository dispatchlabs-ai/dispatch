# Portable worker qualification — October 21, 2026

The [portable protocol](portable-workers.md) ran the whole conversation worker on both an
exe.dev VM and ECS Fargate. Both used the same Nix Linux/AMD64 worker image, non-root UID 65532,
2 vCPUs and 4 GiB memory. A separate synthetic installation supplied PostgreSQL, authentication
and S3 attachments. Existing installations were not migrated.

## Source and method

The worker image was built from `c196972c18f8441858a531d6ff4e6d646589a3cc` with:

```sh
nix build github:dispatchlabs-ai/dispatch/c196972c18f8441858a531d6ff4e6d646589a3cc#workers-oci
```

The Docker archive SHA-256 was
`dce17f1879bfcb4f930c57a593955130a97e93b91b9c7e9b32bb3cec4d64e5d1`;
the registry manifest digest was
`sha256:bdd379becf52af39a0f38106cf927da351991937858869021181bdc0b176e8c5`.
The classic Docker image configuration digest was
`sha256:15c97c96bc044ed29e05096cbced850f075ca0d4cd0689769539262cd93b0dfe`.
These identify different parts of the same image, not competing build results.

The backend additionally included `aa68437`, which normalizes optional command fields through
JSON serialization before validating them. The initial interactive create-chat check found that
an explicit `undefined` field failed validation; the existing HTTP transport had omitted it.
No worker-executed code changed between the two provider runs. TypeScript/application checks
passed after integrating the then-current remote main. Per repository policy, verification used
source review, build checks and manual browser/API scenarios, without automated tests.

The same main service ran on an operator Mac with a local PostgreSQL 17 container. Both workers
reached it through a temporary authenticated TLS relay. Relay setup is a lab dependency, not a
product dependency. Early SSH relay stalls were resolved before the recorded task samples by
using a pinned, authenticated WebSocket relay. This topology does not measure production RDS
latency or production backend hosting cost.

## Observed behavior

- Both providers ran a real model turn and workspace tools: `uname -m` returned `x86_64`, `id -u`
  returned `65532`, and `pwd` returned `/workspace`. Creating and reading `portable-proof.txt`
  produced the same SHA-256, `c8d51369e12c2e3632af81945039aba52b7e01006d3376b3cbfb69c684368913`.
- Worker bootstrap contained only remote store identity, with no PostgreSQL URL or password.
  ECS had no task role, no inbound network rules, and only outbound TCP/443. The main service
  held the database connections. A competing process received a storage conflict; a retired
  attempt and a browser Origin header were rejected with HTTP 403.
- An exe.dev attachment was published to S3, downloaded after container replacement, and
  downloaded again after the drained installation switched to ECS. All downloads retained
  SHA-256 `97d82f8ccc1338f28c299ea73d236bfd48ec6b5e171a50ed1f8c17ec7df8de19`.
  The lab credential endpoint initially used a date representation rejected by the AWS SDK;
  normalizing it to UTC ISO format fixed the setup without an application change.
- Browser Stop interrupted a running workspace sleep on exe.dev. Replacement preserved history
  and the stopped state, while the uncommitted workspace file disappeared. The next turn recalled
  the previous durable reply and did not resume the stopped sleep.
- A lost successful commit reply on exe.dev retried mutation 101 and returned its original
  native commit 54. Killing the backend after a later commit but before its HTTP reply retried
  mutation 146 and returned the original native commit 87 after restart. ECS repeated that
  crash scenario with mutation 104/native commit 56. Each conversation contained one accepted
  prompt and one final reply; the existing worker process continued without application RPC replay.
- A completed provider drain recorded both exe.dev containers as stopped and absent before
  the launcher switched provider. The same conversation store then opened on ECS with its history
  and attachment intact. ECS replacement separately observed the old task STOPPED with exit 0
  before creating a new attempt; the new process recalled the prior reply and reported the
  disposable workspace file absent.
- With a shortened idle interval in the lab, both remaining ECS workers committed their remote
  close receipt and retired. The launcher subsequently reported zero active workers and zero
  unresolved attempts. One operator-status request exceeded its 60-second wait while the two
  retirements were serialized; a fresh read succeeded after they completed.

## Responsiveness and cost

These are individual observations, not distributions or a performance ranking. Fresh conversations
used the same configured `openai/gpt-6-luna` model and equivalent file-task prompts. Model latency,
network placement and caching remain uncontrolled.

| Observation | exe.dev | ECS Fargate |
| --- | ---: | ---: |
| Accepted prompt to final message, fresh conversation | 11.468 s | 11.460 s |
| One warm conversation read | 0.687 s | 0.368 s |
| App-reported model cost for that turn | $0.00096684 | $0.00098635 |
| Confirmed retirement operation, before replacement startup | 9.587 s | 37.172 s |

The fresh ECS create-chat request took 47.147 seconds, including task provisioning and worker
startup; its task reached RUNNING in 39.428 seconds. The first recovered ECS task reached RUNNING
in 31.724 seconds. exe.dev used a pre-provisioned VM and preloaded image, so this run does not
provide a comparable cold-provider provisioning time. Application model-cost figures are estimates
from its usage records, not settled invoices.

At the checked [US East Linux/x86 Fargate rates](https://aws.amazon.com/fargate/pricing/), 2 vCPUs
and 4 GiB cost about $0.09874 per running hour. A dedicated public IPv4 adds
[$0.005 per hour](https://aws.amazon.com/vpc/pricing/), giving about $0.10374 per worker-hour
for this network layout. Billing includes image pull time and minimum durations. At 730 hours,
that is about $75.73 before other services. The 11.460-second model turn therefore cannot be
treated as the whole task's billable lifetime.

The checked [exe.dev Personal plan](https://www.exe.dev/docs/billing/personal) provides a shared
2-vCPU/4-GiB pool for $15/month. The experiment used existing included capacity. This is a pool
price, not $15 per independently provisioned worker; concurrent containers compete for that
capacity. Its included disk and transfer allowances also apply to the pool/account. The
[standalone sandbox price](https://www.exe.dev/pricing) was $0.105 per 2-vCPU/4-GiB hour, which
does not demonstrate a saving over this Fargate configuration.

For one continuously available 2-vCPU/4-GiB pool within its allowances, the fixed $15 equals
roughly 145 hours at the stated Fargate-plus-IPv4 rate. This arithmetic is not a capacity or
availability equivalence. A full installation comparison must additionally allocate the main
service, database, model requests, artifacts, registry, logging and transfer charges. Those shared
hosting costs and final provider invoices were not measured here. The evidence supports trying
the existing pool for suitable small workloads, not a blanket cheaper-provider conclusion.

The later [shared-pool capacity experiment](exe-worker-capacity.md) measures concurrent workers
and defined tool workloads on the existing pool. It adds capacity evidence without changing the
cost scope or treating the VM-count allowance as independently reserved CPU and memory.

## Boundaries

This is an opt-in first slice with one selected execution provider per installation. There is no
automatic active-conversation migration, per-chat VM provisioning, pool autoscaling, portable
ECS warm-spare assignment or preservation of an uncommitted workspace. Confirmation of provider
retirement remains mandatory. Provider outage, sustained load, multi-tenant adversarial isolation,
all tool integrations and broad browser/device acceptance were not qualified by this experiment.
The specific crash and replacement observations do not establish exactly-once external effects.
In this initial provider run, the browser was reloaded after backend restart/handover to restore
its live stream. A reconnect attempt that received HTTP 503 remained at “Reconnecting”; that run
therefore established durable worker recovery, not automatic browser reconnection. The separate
[browser follow-up](#browser-reconnection-follow-up) below repairs and qualifies that client path.

## Browser reconnection follow-up

On October 21, the browser failure was reproduced against an isolated local Dispatch service
with synthetic authentication, SQLite state and a people-only chat. The pre-fix chat component
was byte-identical to public source snapshot `7175747`. A loopback
proxy interrupted the event stream and returned HTTP 503; after restoration, the original client
remained at “Reconnecting” and made no further stream request.

The client had relied on native `EventSource` retry. A non-200 response permanently closes that
object under the [HTML processing model](https://html.spec.whatwg.org/multipage/server-sent-events.html#processing-model).
The error handler updated the notice and fetched state once, but never created a new stream.

The repaired client owns reconnection with a one-to-ten-second exponential delay. Each attempt
refetches authorized chat state and creates a fresh stream with its own snapshot/delta baseline.
It retains the mounted composer, cancels pending recovery on navigation/unmount, and stops on
terminal access errors. It does not replay commands, change workers or reload the page.

Interactive browser observations:

- Repeated stream-only 503 responses recovered automatically; a message saved during the outage
  appeared once, and a later message arrived through the restored live stream. The unsent draft,
  composer focus and caret offset were unchanged.
- Killing the isolated backend, observing repeated failed state reads, then restarting it restored
  the same open chat automatically. A fresh chat view whose initial state fetch received repeated
  503 responses also recovered without a refresh.
- Leaving a reconnecting chat stopped its read/stream attempts; returning opened a fresh stream
  and retained the draft. Injected 403 and 404 responses cleared protected history and stopped
  automatic retries. Real session revocation returned the browser to sign-in both with a live
  stream and while reconnecting; retries stopped after sign-out.
- Whole-page reconnecting/loading/recovered states were reviewed at 1440×900, 1280×720,
  768×1024 and 390×844, with no horizontal page overflow. These are browser viewport checks,
  not qualification on physical phones or every browser engine.

TypeScript and build checks passed with `nix develop --command npm run check`. No automated
tests were added or run under the repository policy. Captures and fault/request observations
are retained in the task worktree's gitignored `.local/browser-reconnect/`. This follow-up used
the real local app without model execution; it does not repeat ECS/exe.dev qualification or
establish seamless recovery for every provider outage. Existing installations require a later
release/update to receive the repaired browser assets.
