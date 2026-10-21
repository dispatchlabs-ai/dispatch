# Shared-conversation design concepts

**Approved for implementation October 5, 2026.** The approved concepts used a shared-channel visual model for the accepted conversation behavior. They use Dispatch's light theme, navy/aqua palette and existing project navigation. [WP-024](handoff.md#ui-and-conversations) records implementation and qualification evidence.

The sample messages and agent definitions are illustrative. The concepts do not establish that Designer or Reviewer is registered, that an invitation occurred, or that a displayed status is live.

## Conversation and replies


Humans and agents share one left-aligned message flow with avatars, author names, timestamps and compact spacing. Agent badges and distinct icons preserve identity. A membership button in the conversation header opens participants; an inline reply count opens the related discussion in the right column. Project groups remain in the sidebar.

The approved reply-thread panel follows the shared thread contract: replies remain visible to all members, agents consider them with their thread context, and automatic replies retain that context. The mockup does not add calls, reactions, canvases or Slack's other features to scope. Showing one open conversation explains the absence of the existing multi-tab strip; this concept does not remove support for open conversation tabs.

## Choose starting agents


New conversation presents available agent definitions before creating any instances. The current project remains visible, selected rows have checkmarks, and Start conversation makes the creation action explicit. People and more agents can be invited later. No additional required name or model field is introduced.

## Participants and invitations


Participants occupy the same contextual column used by a thread. A human-facing invitation dialog separates Agents and People, identifies current members, and explains that newcomers can read the full history. The selected participant's details distinguish its reusable definition from this conversation's instance. Agent-initiated invitations appear as attributed events in the shared message history.

The disabled Already here rows illustrate inviting a missing role. They do not establish a new product restriction on how many instances of a definition may exist.

## Phone layouts


The conversation remains a single readable message column. Participants and creation use separate mobile surfaces with persistent actions. The design retains the existing Menu and Details entry points instead of shrinking desktop columns onto a phone.

## Design record

The earlier generated mockups and prompt transcripts were removed from the
public source because they contained personal identities. This text preserves
the accepted interaction structure; it does not establish runtime verification.
The [project concept](assets/projects-desktop.png) remains a synthetic design
reference. See the [layout refinements](conversation-layout-refinements.md) and
[implementation overview](handoff.md#ui-and-conversations) for criteria and limits.
