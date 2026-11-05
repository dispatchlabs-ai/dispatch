# Fleet use cases

- **FLEET-001 — Run independent durable workflows:** an installation admits complete
  native runs on replaceable workers while retaining company and transport authority.
- **FLEET-002 — Resume on another host:** fence the previous writer, retain native
  history/source/artifacts, and recover the same immutable application and image.
- **FLEET-003 — Change capacity:** add/remove workers based on observed pressure,
  move work to spare capacity, and gracefully release a terminating host.
- **FLEET-004 — Stop work:** distinguish suspension, durable cancellation and
  verified completion; uncertain release retains ownership until fencing.
- **FLEET-005 — Bind transports:** keep Slack or another transport's credentials
  on the coordinator and acknowledge remote events after retaining delivery receipts.
