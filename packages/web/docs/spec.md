# Project spec access

The live project spec is Markdown stored only in Dispatch's database. This file contains no spec body or exported snapshot and is not an editable source of project intent.

- **People:** open Projects → project → Spec. Use Write spec or Edit spec, then Save. Save persists a database revision; it does not write a repository file or start agents.
- **Chat agents:** call `conversation_project_spec` for this chat's project. Omit revision to obtain current; for an exact read or continuation, pass the returned revision and nextOffset as offset until nextOffset is null. Keep the revision fixed across pages. The tool cannot select another project; current access is enforced.
- Reading intent does not authorize adopting changes, expanding scope or starting work. Follow current human direction, the chat goal, permissions and Stop.
- Git retains the retired file's history. Do not restore that history as live authority, synchronize a file copy, or infer that a read error authorizes replacing database content.

Repository product documentation remains local:
- [Project usage and recovery](usage-guide.md#shared-projects)
- [Runtime contracts](runtime.md)
- [Contribution and release policy](../../../CONTRIBUTING.md)
