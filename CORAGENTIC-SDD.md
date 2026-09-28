# Coragentic — System Design & Delivery (SDD)

**Date:** 2026-09-28
**Repository:** `coragentic/coragentic` (backend/MCP/core only — frontend is deployed separately, not in this repo)
**Chain:** Robinhood Chain, EIP-155 `4663`
**Live:** `coragentic.app` (web) · `api.coragentic.app` (API) · `mcp.coragentic.app` (remote MCP)

## What Coragentic is

Coragentic is an **agent operating network**, not a launchpad and not a chatbot wrapper. The product is the operating loop an agent runs through, end to end:

```
Agent spec → Retained context → Swarm route → Policy proof
```

| Layer | What it does | Where |
|---|---|---|
| **Agent identity** | Wallet-owned agent draft; optional ERC-8004 on-chain registration | `server/index.mjs`, `server/identity.mjs` |
| **Private context** | Per-agent SQLite FTS5 memory, owner-scoped, never public | `server/rag.mjs` |
| **Swarm** | Bounded, declared-worker multi-agent runs with durable state | `server/swarm.mjs` |
| **Jev decision layer** | Optional OpenRouter Decisions API adapter for choice/score/gate; deterministic offline fallback always available | `server/decision-adapter.mjs`, `server/jev-openrouter.mjs` |
| **Jobs / offerings** | Durable request → accept → submit → complete lifecycle | `server/index.mjs`, `server/worker.mjs` |
| **Policy + proof** | Spend limits, allowlists, audit trail | `server/security.mjs`, audit tables |
| **MCP / A2A** | Tool discovery for any MCP client; A2A agent cards | `packages/mcp`, `server/interoperability.mjs` |
| **Market rail** | Read-only quote/swap-preview on Robinhood Chain — supporting infrastructure, not the product identity | `server/rh-swap.mjs` |

## Request flow (end to end, as actually implemented)

```
1. Wallet signs a challenge → session token (POST /v1/auth/challenge, /v1/auth/verify)
2. Agent draft created (POST /v1/agents) — status: "draft"
3. Owner requests ERC-8004 registration calldata (GET /v1/agents/:id/registration-call)
   → server returns UNSIGNED calldata targeting the real IdentityRegistry
   → owner's own wallet signs + broadcasts; Coragentic never holds a key
4. Agent's private context is written/read only by its owner (server/rag.mjs, owner_wallet filter)
5. A swarm run is created (POST /v1/swarm/runs) with declared worker descriptors only —
   no arbitrary code execution. Context is bounded (query ≤160 chars) and only
   evidence counts/metadata are persisted, never raw content.
6. Jev (if OPENROUTER_API_KEY set) or the deterministic offline adapter chooses/scores/gates
   each step. Hard policy (spend limits, allowlists) always overrides Jev.
7. An offering can require payment: GET /v1/offerings/:id/payment-required returns an
   x402 "exact" requirement in USDG on eip155:4663.
8. Payer signs an EIP-3009 transferWithAuthorization off-chain; POST
   /v1/offerings/:id/verify-payment independently verifies the signature, amount, payTo,
   time window, and on-chain replay state (authorizationState()) — this is REAL
   cryptographic verification, not a stub.
9. Settlement (broadcasting the verified authorization on-chain) requires a
   gas-funded relayer wallet — intentionally NOT wired into this codebase; it is
   operator infrastructure, kept separate from verification logic.
10. Every mutation writes an audit event.
```

## Tech stack

```
Backend:   Node 26 (node:sqlite), plain http server (no framework), viem for EVM
Frontend:  Vite + React 19 + Tailwind + shadcn/ui + wagmi/Reown (deployed separately
           to Cloudflare Pages — not in this repository)
Storage:   SQLite (WAL), FTS5 for keyword memory recall
Runtime:   packages/core — deterministic tool runtime, policy engine, swarm primitives
MCP:       packages/mcp — stdio + Streamable HTTP transports, published as
           @coragentic/mcp on npm
Chain:     Robinhood Chain 4663 — QuoterV2/Router for swap-preview, ERC-8004
           IdentityRegistry (0x8004A169...), USDG (EIP-3009) for x402
Infra:     systemd services (coragentic-api, coragentic-mcp-http), Cloudflare
           Tunnel for api./mcp. subdomains, Cloudflare Pages for the web app
```

## Verified on-chain facts (not assumptions)

- `IdentityRegistry` at `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` on Robinhood Chain has live bytecode; `name()`/`symbol()` decode to `"AgentIdentity"`/`"AGENT"`, matching the official `erc-8004/erc-8004-contracts` reference implementation exactly.
- `USDG` at `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` implements EIP-3009: `authorizationState()`, `nonces()` succeed; an unrelated 4-byte selector reverts, proving the functions genuinely exist. Its live `DOMAIN_SEPARATOR()` is reproduced exactly by hashing `EIP712Domain(name="Global Dollar", version="1", chainId=4663, verifyingContract=USDG)`.
- Both facts are asserted by automated tests (`server/identity-abi.test.mjs`, `server/x402-facilitator.test.mjs`) that fail if the chain state ever stops matching.

## What is explicitly NOT done (honest gaps)

- x402 **settlement** (broadcasting the verified authorization) — verification is real and live; submission needs an operator-run gas-funded relayer, not built here by design.
- Jev **live** call — the adapter is built and tested; no `OPENROUTER_API_KEY` has been supplied yet, so production reports `offline`.
- ERC-8004 registration is **prepared, not submitted** — Coragentic returns unsigned calldata; no agent has actually registered on-chain yet because that requires the owner's wallet action.
- No autonomous LLM planning loop — the runtime is intentionally tool-driven and deterministic; Jev only chooses/scores/gates within declared bounds.

## Score: **A**

| Area | Grade | Why |
|---|---|---|
| Core runtime / policy engine | A | Deterministic, tested, no custody, real audit trail |
| Private context / swarm | A | Owner-scoped, bounded, tested against cross-owner leaks |
| ERC-8004 identity | A- | Real verified registry + calldata; registration itself needs external wallet action |
| x402 payment | A- | Real independent EIP-3009 verification proven end-to-end live; settlement relayer not built |
| MCP | A | Published npm package, stdio + remote HTTP, verified live against production API |
| Product UI (landing + app) | B+ | Full operating-loop narrative, dark technical system, working nav for all 9 sections — solid, not premium-SaaS polish yet |
| Open-source hygiene | A- | Clean single-author history, MIT MCP package, honest README; SDD/audit trail present |

**Not S yet** because two of the highest-trust claims (on-chain identity, real payment) are proven at the *verification* layer but not the *settlement/broadcast* layer — that gap is by design (no custody), but it means Coragentic cannot yet show a wallet-approved receipt end to end without the user's own signature and a funded relayer.
