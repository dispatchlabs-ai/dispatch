# Stopped-backend recovery

Backend PostgreSQL provider, MCP and routing stores retain owner latches after an unclean exit. Ordinary restart refuses those latches. An advisory lock becoming available, a disconnected database session, or possession of an owner UUID does not prove the old backend stopped.

Before recovery, independently confirm termination of the old backend and prevent its supervisor/host from restarting it. Record that evidence. Worker retirement is separate: surviving workers may still need authenticated backend callbacks to complete drain. Do not infer worker retirement from backend termination.

For ECS recovery, hold the backend service at zero throughout the one-off invocation. Keep the normal launcher reachable; if it also stopped, independently confirm its termination before bringing it back first. The recovery backend needs that launcher for its subsequent drain and graceful shutdown. Confirm the one-off backend STOPPED before starting the normal flag-free backend service.

Read the retained owner IDs using existing scoped backend credentials for the respective databases, not the RDS master role. Do not delete or update latches with SQL. Supply only IDs for retained latches, using the normal backend executable/configuration plus these one-invocation arguments:

```text
--confirm-retired-backend
--recover-routing-owner <retained-routing-owner-uuid>
--recover-provider-owner <retained-provider-owner-uuid>
--recover-mcp-owner <retained-mcp-owner-uuid>
```

Each supplied ID requires its corresponding PostgreSQL store configuration. Wrong IDs, live owners, missing confirmation and unknown arguments are refused. The confirmation flag is an operator assertion, not an automated fencing mechanism. Never put recovery arguments in a retained Compose command, service definition or automatic restart policy.

Recovery persists public admission closed before opening provider/MCP stores. It does not automatically refresh models, discover MCP connections or undrain. If matching launcher evidence does not confirm retirement, authenticated worker support remains available; this is not backup readiness. Use the authenticated drain operation and require matching launcher identity, complete retirement and backend quiescence before capture. Explicit authenticated undrain is a separate decision.

If startup fails after only some owners recover, inspect the remaining retained IDs again: successful cleanup clears only owners acquired by that invocation. Never blindly replay obsolete recovery IDs. After a successful graceful stop, restart using the normal command without recovery arguments.

This is backend-owner recovery only. Launcher ownership, Pi endpoint markers, worker stores, encrypted backup/key pairing and retired executor denial retain their separate runbook requirements. No existing-installation migration or activation is authorized by these instructions. At introduction, source/build checks pass; crash/recovery invocation and integrated Linux recovery remain unqualified.
