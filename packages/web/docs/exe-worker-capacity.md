# exe.dev worker capacity — October 21, 2026

**Eight resident workers is a reasonable starting budget for the modest working set measured
here. Sixteen workers passed light model/tool workloads, but left too little memory for several
larger tools. Two CPU-bound jobs used both cores at essentially the single-job speed; additional
jobs shared that throughput.** The backend and database were outside the pool.

Sixteen is the highest resident count tested, not an established idle-only maximum. No product
concurrency limit or subscription change was made. These results support a workload budget,
not a guarantee that an arbitrary number of compilers, browsers or large agent sessions will fit.

## Results

All expected file/write/read/hash results were verified in the following complete rounds.
Latency ends at the first matching tool result, before any additional agent-selected commands.

| Resident workers and simultaneous requests | Rounds / verified results | Median first-tool latency | Observed range |
| --- | ---: | ---: | ---: |
| 2 | 3 / 6 | 7.55 s | 6.77–8.01 s |
| 4 | 2 / 8 | 6.94 s | 6.66–7.67 s |
| 8 | 3 / 24 | 7.59 s | 6.72–9.88 s |
| 12 | 2 / 24 | 7.86 s | 7.15–16.38 s |
| 16 | 2 / 32 | 7.36 s | 6.50–9.06 s |

Fourteen of these 94 turns issued extra commands. The expected outputs still completed, but
these are first-result measurements, not evidence that every agent followed the one-command
instruction or that the whole turn always finished at that timestamp.

The fixed CPU workload shows the distinction between resident count and available compute:

| Simultaneous CPU jobs | Median compute time per job | Invocation |
| --- | ---: | --- |
| 1 | 4.56 s | Agent tool |
| 2 | 4.75 s | Agent tools |
| 4 | 9.50 s | Agent tools |
| 8 | 19.21 s | Agent tools |
| 12 | 28.44 s | Fixed command inside each worker |
| 16 | 38.70 s | Fixed command inside each worker |

Every CPU job completed. Both sixteen-job runs passed, with medians of 38.70 and 38.86 seconds.
More jobs did not create more CPU throughput: sixteen shared jobs each took about eight times
as long as two shared jobs. These are short samples, not a statistically controlled provider
performance comparison.

Memory was the practical boundary. Each active job in this table held an additional touched
192-MiB buffer while doing the CPU work; inactive workers remained resident.

| Resident workers | Active memory jobs | Result | Minimum sampled available host memory |
| --- | ---: | --- | ---: |
| 8 | 8 | All passed; 19.66 s median compute | 615 MiB |
| 16 | 4 | All passed, but heavy memory pressure; 19.64 s median | 103 MiB |
| 16 | 8 | Three tool invocations exited 137; one resident worker died | 68 MiB |
| 8, after reducing residency | 8 | All passed again; 19.11 s median, no new OOM or memory stalls | 650 MiB |

The sixteen-resident overload produced five kernel OOM kills: one conversation-worker process,
two additional tool processes and two small host user-session helpers. The experiment VM was
disposable. The four-job run at that density had already spent about 5.7 seconds in full memory
stall, so completion alone would have overstated its headroom. CPU and memory readings had
sampling gaps under that pressure; the sampler recorded four Docker-read errors and a maximum
20.7-second gap. Kernel kill records and process exit codes corroborate the overload.

After the light rounds, sixteen workers occupied about 2,693 MiB of cgroup memory and the host
had 960 MiB available. Earlier idle snapshots ranged from roughly 150 to 240 MiB per worker,
depending on startup, history, garbage collection and shared pages. Do not extrapolate the
smallest idle footprint into a safe active-work limit. Eight resident workers had enough room
for the defined additional working set in both the agent-driven and fixed-command runs.

### Cold starts

A single additional worker took 22.4 seconds. Creating two more workers in parallel took up to
52.7 seconds; the next batches of four took 158 and 237 seconds. The last batch, reaching sixteen,
ran past roughly five minutes: one create response and its first reconciliation read timed out.
The existing chat was subsequently read successfully in 0.302 seconds, without replaying its
creation or making a duplicate.

The driver performs repeated sequential remote inventory/identity checks, and admission is
serialized. These timings include that control work and worker initialization. They are not
pure VM boot times, and warm-task latency should not be used to promise equally fast cold starts.

## Source and method

This manual experiment placed separate Dispatch conversation-worker containers on one exe.dev
Personal-pool VM with 2 vCPUs and 4 GiB of memory. The guest reported 3,909 MiB of physical memory
and no swap. The backend and PostgreSQL 17 ran on a separate operator machine; an authenticated
HTTPS relay on the VM connected the workers to that backend. Its overhead is included in the
host measurements. The model ran at its provider, not on the VM.

The Linux/AMD64 Nix image was built from
[`f06cb0e`](https://github.com/dispatchlabs-ai/dispatch/commit/f06cb0ec18711e39dc4fb0c600a6fac95b86598b):

```sh
nix build github:dispatchlabs-ai/dispatch/f06cb0ec18711e39dc4fb0c600a6fac95b86598b#workers-oci
```

The Docker image ID was
`sha256:ebc1a8b897b11c9e58d471e07473e426cda91036c2727dc246e363847f39ed99`;
the compressed Docker archive SHA-256 was
`81bed2677c37cd97733f93eefdfd570678e8e65b8d4e06581d4b4e89117a5e18`.
The image ID came from Docker inspection, not the archive configuration filename.

Each worker used the portable `remote-v1` protocol, UID 65532, its own disposable workspace,
and the same Developer agent with `openai/gpt-6-luna`, thinking off. Workers shared the VM's
resources. Their individual 2-vCPU/4-GiB container ceilings were not resource reservations.
Idle retirement was disabled for the experiment so resident-worker density could be observed.
No application concurrency limit was added.

Authenticated application requests created separate conversations and submitted real model
turns in parallel. Worker tool traces supplied command results, errors and completion times.
The VM sampled host memory, CPU, pressure and each worker's cgroup memory, CPU and OOM counters
once per second. The workloads were:

- **Light:** write a small unique file, read it back and calculate its SHA-256 with Node.
- **CPU:** compute a 32-byte PBKDF2-SHA256 result using 32 million iterations. The Node processes
  waited for the same timestamp before computing, so model-response jitter did not spread out
  the intended simultaneous load. Reported compute time excludes this wait.
- **Additional memory:** hold a touched 192-MiB buffer while running the same synchronized CPU
  workload, then verify its size and end bytes. This is a defined synthetic working set, not a
  measurement of a particular compiler, repository or browser.

Light-task latency is measured from the native accepted-message timestamp to the first verified
result for that request. Public reply times are separate: agents can post through a conversation
tool or finish silently after the requested workspace operation. Traces preserve repeated or
unrelated commands and command errors as deviations. They are not host-capacity failures. The
first synchronized memory group at eight workers finished before the additional commands began.

Higher-count hardware probes invoke the same Node CPU/memory command directly through Docker
inside the already-running worker containers. A shared timestamp starts those processes together.
This removes model-selected extra work from the resource measurement; those probes do not measure
end-to-end model-turn latency. Counts describe resident native workers and simultaneous work in
this topology, not independent full-sized machines.

## Setup corrections and verification

A fresh combined-workspace installation initially failed before backend/worker startup because
Pi Coding Agent 1.1 resolved a newer codemode dependency without its expected export. The scoped
dependency overrides in the measured revision keep that runtime on matching Chord/codemode 1.1
while the standalone runner keeps its Pi 1.3 dependencies. Fresh installation, backend and
Linux-worker startup, runner/Slack imports, TypeScript/application builds, the macOS Nix package,
host flake checks and the Linux worker-image build passed after that correction.

The first launch attempt also used an incorrect image identifier in the experiment configuration;
it is excluded from cold-start timing. Early measurement prompts used unnecessarily complicated
shell quoting, and the observer initially recognized only final-message/idle completion. Those
fixture issues were corrected before the controlled higher-count measurements. A single provider
API TLS-handshake timeout during provisioning was recorded separately from resource pressure.

These were manually invoked live application/API scenarios. No automated test suite was added
or run, following the repository's testing policy. The experiment did not migrate an existing
installation or change the subscription.

## Interpretation and limits

The [Personal plan](https://www.exe.dev/docs/billing/personal) supplies a shared resource pool.
Its VM-count allowance does not provide that CPU and memory allowance independently to every VM
or every conversation container. The [portable-worker configuration](portable-workers.md) uses
one operator-provisioned host and does not provision or resize a VM for each conversation.

These short, repeated workloads do not establish long-duration reliability, a production
admission limit, browser/build memory requirements or the capacity of a backend/database hosted
inside the same pool. A larger working set reduces the number that fits, and CPU-heavy jobs
share two cores. Keep room for workload variation and measure the actual tools before selecting
a production workload count. The earlier [provider qualification](portable-worker-qualification.md)
records storage, replacement and recovery behavior separately.
