# Service tracing

`telemetry.ts` uses the stock OpenTelemetry Node SDK and OTLP HTTP exporter.
It is enabled only when `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` is set. The AWS
module supplies a loopback ADOT collector at
`http://127.0.0.1:4318/v1/traces`; HTTPS exporters are also accepted. Endpoints
must not contain credentials, queries or fragments. `OTEL_SERVICE_NAME` selects
a short nonsecret service label; `OTEL_TRACES_SAMPLER_ARG` is a ratio from 0 to 1
(default `0.1`). No environment/host resource detector or automatic instrumentation
is installed. The module, not this SDK, owns collector IAM and backend retention.

Backend, launcher, rolling listener and worker HTTP middleware record registered
route templates, normalized method, status and response-header duration. They do
not inspect or wrap response bodies: SSE lifetime and stream completion are not
measured. Internal JSON calls record transport duration through body decoding;
controller forwarding spans end at response headers. W3C `traceparent` links
these requests; baggage and tracestate are not copied through controller forwarding.
Incoming sampling flags cannot override the local ratio. Generated trace IDs are
X-Ray compatible. Trace context is diagnostic, never authorization or durable
operation identity.

Sampled requests and server failures produce JSON stdout records with the same
trace/span IDs at the outer request boundary; nested in-process owner dispatch
retains its span without duplicating the request-summary log. Readiness/liveness
polling is excluded. No raw URLs, queries,
headers, exceptions, SQL, environment values, model/tool inputs/results or native
Pi Durable traces are exported by this instrumentation. The HTTP error handler
also avoids printing raw exception objects. This is not a blanket guarantee about
arbitrary subprocess output or other logging elsewhere in the application.

The SDK batches spans in a bounded queue and drops telemetry under pressure;
export failure does not retry application operations. Normal service shutdown
flushes telemetry after closing the application owners. Forced termination may
lose unexported spans. Operator initializer, activation and private credential
terminal definitions do not receive telemetry configuration from the module.

This is service-transport observability, not an exporter for Pi's durable history
or its explicit `TelemetryContext` contract. No second agent scheduler or recovery
mechanism is introduced. Runtime trace delivery/correlation, exporter failure,
interruption and streaming behavior require separately authorized qualification.
