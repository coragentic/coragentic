# @coragentic/core

A small, deterministic foundation for tool-driven agents.

## Capabilities

- Normalize and validate an ERC-8004-compatible registration-shaped manifest locally.
- Expose an explicit allowlist of tools from manifest services.
- Validate tool input through a caller-provided schema callback.
- Enforce deterministic spend limits: per-call amount, daily amount, assets, and recipients.
- Apply per-tool or per-call timeouts.
- Emit structured requested, approved, rejected, completed, and failed audit events.
- Optionally delegate `retain`, `recall`, and `forget` calls to an injected, provider-neutral `MemoryAdapter`, with requested, completed, and failed audit events.
- Run with Node.js and no LLM, wallet, chain, or provider dependency.

## Non-capabilities

- It does not register anything on-chain or claim an on-chain identity.
- It does not hold keys, sign transactions, broadcast payments, or connect to a wallet.
- It does not call an LLM or make autonomous planning decisions.
- It does not provide persistence, a memory backend, distributed locks, or durable audit storage. Memory only exists when the application injects an adapter; the core package does not choose or ship a storage provider.
- It does not treat a manifest as proof that a service exists or is trusted.

The runtime is intentionally provider-neutral: applications supply tool implementations and decide how approved requests are executed.
