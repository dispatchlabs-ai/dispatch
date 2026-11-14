# Changelog

## [Unreleased]

- Expose native agent discovery, messaging, status and work waits through the shared host contract. Automatic replies return as new inputs to the sending conversation.
- Bind Runner callers to their executing conversation and stable native tool identity, preserving recipient selection, recovery and independent cancellation.

## [0.17.0] - 2026-11-13

- Add an optional MCP connector over the existing AgentClient contract: discover agents, create/find conversations, send input, inspect progress and results, retrieve artifacts and stop work.
- Support stdio and authenticated Streamable HTTP without starting a second host; defer host connection until tool invocation so agents in the same host can call one another.
- Preserve durable request identities, native receipts and observation-only cancellation.
