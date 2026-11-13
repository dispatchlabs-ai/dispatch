# Changelog

## [Unreleased]

- Add an optional MCP connector over the existing AgentClient contract: discover agents, create/find conversations, send input, inspect progress and results, retrieve artifacts and stop work.
- Support stdio and authenticated Streamable HTTP without starting a second host; defer host connection until tool invocation so agents in the same host can call one another.
- Preserve durable request identities, native receipts and observation-only cancellation.
