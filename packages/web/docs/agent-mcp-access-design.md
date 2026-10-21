# Agent editor — MCP access concept

October 6, 2026. The maintainer requested a longer ImageGen screenshot making MCP access clearer in the [revised agent editor](agent-definition-design-v2.md). This follow-up replaces the passive Connections summary with a proposed connection-management section. It is a visual design, not an implemented access change.


## What the historical screen showed

- **MCP connections → Add connection** selects a service for this agent. The adjacent **Settings → Connections** link separates registering/authenticating a server from choosing which agent can use it.
- The example remote service card shows the endpoint, selected agent identity, server-provided access summary, and all nine discovered tools. Tools are displayed for inspection, not as independent permission switches. Identity selection means choosing an authorized credential-backed identity, not typing an arbitrary name. Credentials are not entered in this editor.
- **Server connected** describes connection health. **Pending addition** means this agent has not yet received the pictured access. The agent identity and access shown are illustrative; this design task did not enroll Recovery Engineer or grant it access.
- **Apply access when saved** explicitly chooses new instances only or new and existing instances. The pictured selection is new instances only. The save summary states that existing instances remain unchanged.
- **Save changes** is the single primary action. It proposes saving definition revision 4 and applying the staged connection selection together; **Discard changes** and **Remove pending connection** operate on the draft.

The former image kept identity, instructions, model, and capabilities visible above the expanded MCP section. Project assignment remains in its separate flow. The longer format is a full-page desktop concept, not a phone layout or an actual application capture.

## Implementation boundary

The historical concept illustrates staged MCP selections; see the [usage guide](usage-guide.md#connect-an-mcp-server) for current setup.

Definition revisions and connection grants are distinct concerns in the current runtime. The screenshot's combined draft/save interaction is a proposal, not an existing transaction guarantee or a claim that upstream permissions are pinned to definition revisions. Implementation must settle authorization for management actions, stable identity binding, save failures and partial application, conflicts, and the exact effect on existing instances. Server grants and revocation remain authoritative independently of the editor.


The historical provider-specific illustration and generation record were retired during the documentation reset; their originals remain in Git history.
