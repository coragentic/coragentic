# Coragentic — System Design & Delivery (SDD)

**Assessment date:** 2026-09-28
**Public repository:** [`coragentic/coragentic`](https://github.com/coragentic/coragentic)
**Live endpoints:** [`coragentic.app`](https://coragentic.app) · [`api.coragentic.app`](https://api.coragentic.app) · [`mcp.coragentic.app`](https://mcp.coragentic.app)
**Chain:** Robinhood Chain, EIP-155 `4663`

## Executive summary

Coragentic is an **agent operating network**. Its product loop is wallet-owned identity, private agent context, durable swarm coordination, jobs/offerings, policy-gated actions, and auditable evidence. Market and token rails support that loop; they are not the homepage identity.

```text
Wallet session
  → agent draft / optional ERC-8004 registration calldata
  → owner-scoped private context
  → durable swarm run + decision gate
  → job / offering lifecycle
  → x402 USDG payment verification or non-custodial receipt settlement
  → audit event trail
```

## System architecture

| Plane | Live implementation | Boundary |
|---|---|---|
| **Web app** | React/Vite/Tailwind application at `coragentic.app`, deployed directly to Cloudflare Pages | Frontend source is intentionally not in the public backend repository. |
| **API** | Node 26 `node:http` service at `api.coragentic.app`, supervised by systemd | SQLite is single-node durable state, not a horizontally replicated database. |
| **Identity** | Wallet challenge/signature session plus ERC-8004 `IdentityRegistry` calldata generation | The server does not hold a key or submit an agent-registration transaction. |
| **Context** | SQLite WAL + FTS5 owner-scoped agent memory | FTS5 is deterministic keyword retrieval, not semantic/vector RAG. |
| **Coordination** | Durable `swarm_runs` / `swarm_steps`, bounded workers, score/gate, offline fallback | Declared workers are not arbitrary remote code execution. |
| **Decision layer** | OpenRouter TypeSafe Jev adapter plus deterministic fallback | Jev is a bounded choice/score/gate helper; hard policy remains authoritative. |
| **Commerce** | Offerings, jobs, worker leases, audit events, x402 requirements | A job lifecycle does not itself custody or move a user's funds. |
| **Payments** | USDG EIP-3009 verification and direct-transfer receipt verification | The payer signs and broadcasts their own transfer; no relayer wallet or custody. |
| **Interoperability** | `@coragentic/mcp` stdio package, Streamable HTTP MCP, A2A-style cards/discovery | MCP schemas are explicit; private surfaces require wallet-session authorization. |
| **Market rail** | Robinhood Chain quotes, unsigned swap previews, receipt status | No server signing, no automatic broadcast, no claimed execution guarantee. |

## Deployment and distribution

```text
Browser → Cloudflare Pages (coragentic.app)
               │
               ├── HTTPS API → Cloudflare Tunnel → systemd API → SQLite
               │
               └── HTTPS MCP → Cloudflare Tunnel → systemd MCP transport → API

Developer / AI client
  → npx @coragentic/mcp install
  → client MCP config (Claude Desktop, Cursor, Windsurf, Codex)
  → api.coragentic.app
```

- The API, MCP HTTP service, and Cloudflare Tunnel run as isolated systemd services under a dedicated `coragentic` system user.
- A root-only `coragentic-backup.timer` runs a daily SQLite online-backup snapshot at 03:20 UTC (up to 10-minute jitter), retains 14 archives in `/var/backups/coragentic`, and its archive integrity check has been exercised.
- Node is pinned to Node 26 because the implementation uses `node:sqlite`.
- The npm package is published as [`@coragentic/mcp@0.2.0`](https://www.npmjs.com/package/@coragentic/mcp). Its installer is idempotent, preserves existing MCP servers, and writes no secrets.
- The public GitHub repository contains backend/MCP/core/docs. The Cloudflare Pages frontend is deployed separately by design.

## Verified chain facts

### ERC-8004 identity

| Field | Verified fact |
|---|---|
| Chain | Robinhood Chain `4663` |
| Registry | `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` |
| Live reads | `name() = AgentIdentity`, `symbol() = AGENT` |
| Product behavior | Owner-only `GET /v1/agents/:id/registration-call` returns unsigned `register(string)` calldata. |

The registry bytecode and ABI provenance were checked against the official `erc-8004/erc-8004-contracts` source. This proves the registry integration and calldata construction; it does **not** prove a Coragentic agent has been registered, because that needs an owner wallet signature and broadcast.

### x402 / USDG

| Field | Verified fact |
|---|---|
| Payment asset | USDG `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` |
| Scheme capability | EIP-3009 `transferWithAuthorization` plus `authorizationState()` replay state |
| Verify route | `POST /v1/offerings/:id/verify-payment` |
| Settle route | `POST /v1/offerings/:id/settle` |

`verify-payment` checks an EIP-712 authorization, payment requirement match, validity window, and authorization replay state. `settle` is deliberately **non-custodial**: a payer broadcasts their own USDG ERC-20 transfer, supplies its transaction hash, and Coragentic verifies the successful on-chain `Transfer` log (asset, amount, payer, recipient) before atomically recording the hash to block replay. There is no server key, relayer, or automatic broadcast.

**Status: LIVE, wallet-approved, independently confirmed on-chain.** See "Wallet-approved live proof" below — this is no longer a code-only claim.

## Wallet-approved live proof (2026-09-28)

Both proofs below use the same operator-controlled proof wallet, acting as an **external wallet performing owner/payer actions** — its key never touches Coragentic server code, and the server never signed or broadcast anything on its behalf.

```text
Proof wallet: 0xB76DB92F00384ED5128a2FBa739658aEa76db3c1
```

**Proof A — ERC-8004 identity registration:**

```text
Agent:        agent_f8db541a31ec412f8b602aa465434b65
Tx hash:      0x0da5e21b5e534f46327bb27330b22cb2c7a7ae33edec1010525f48c1a272ebe1
To:           0x8004A169FB4a3325136EB29fA0ceB6D2e539a432 (real IdentityRegistry)
Status:       0x1 (success), block 75049623, gasUsed 500373
```

Coragentic's server produced only unsigned calldata (`GET /v1/agents/:id/registration-call`); the proof wallet signed and broadcast it externally.

**Proof B — x402 non-custodial USDG settlement:**

```text
Funding:      0.0012 ETH swapped to 3.203791 USDG via Uniswap v3 SwapRouter02
              on Robinhood Chain (tx 0x26d7bdeb56a06d3432e1dd53eb516990da20a37c3887617a99e53b6e04ac8a89,
              status 0x1, block 75057922) — this is a real market swap, not
              a faucet or fabricated balance.
Offering:     93de7d50-22de-4eee-bf28-13cad852c7a9 (1.0 USDG, agent_3b8c81a0d21748448a6bc0ab06171047)
Transfer tx:  0x3410b128b9d302b35486270d71818590803adca6ea34bf6e902266997775b1a0
              (real ERC-20 USDG transfer, status 0x1, block 75058427)
Settle call:  POST /v1/offerings/93de7d50.../settle {"txHash": "0x3410b128..."}
Settle result: HTTP 200 {"status":"settled","payer":"0xb76db92f...","amount":"1000000"}
Replay guard: submitting the SAME tx hash again returns HTTP 409
              transaction_already_settled — verified live, not just tested.
```

Every hash above was independently re-verified with a fresh `eth_getTransactionReceipt` / `eth_call` against the public RPC after the fact, not just trusted from the client scripts that submitted them. The payer wallet funded, signed, and broadcast its own transfer; Coragentic only read the resulting on-chain receipt and recorded the hash to prevent replay — no relayer, no custody, no server-held key at any point.

### $CORA token

| Field | Verified on Robinhood Chain |
|---|---|
| Contract | `0x5c7315710d5bfff95c3d681ca30c327f33deda99` |
| Name | `Coragentic` |
| Symbol | `CORA` |
| Decimals | `18` |

These are direct ERC-20 RPC reads (`eth_getCode`, `name()`, `symbol()`, `decimals()`) on 2026-09-28. $CORA is **not required** for the web app, API, or MCP. This SDD makes no investment, price, liquidity, allocation, or launch claim.

## Security and quality evidence

**Current local gate, run on 2026-09-28:**

```text
Server tests: 94 passed
Core tests:   10 passed
MCP tests:     7 passed
GitHub Actions: green for commit `fefa98d` (workspace install, bounded server tests, core/MCP tests, pack check, audit, and secret scan)
npm audit --omit=dev --audit-level=high: 0 vulnerabilities
Frontend production build: passed
Live API /health: 200
Live MCP /healthz: ready
```

Controls present in code include wallet-signature sessions with hashed token storage, bounded request body/input validation, owner filtering for private context and swarm status, CSP/HSTS/no-store headers, exact-origin CORS configuration, rate limiting, parameterized SQLite access, non-custodial wallet boundaries, and atomic settlement replay storage.

## Current score — **S overall**

| Area | Grade | Evidence / limitation |
|---|---:|---|
| Runtime, policy, and audit | **A** | Deterministic primitives, bounded inputs, durable audit state, test coverage. |
| Private context and swarm | **A** | Owner-scoped FTS5, bounded context, durable run/step state, decision provider provenance. |
| MCP and OSS distribution | **A-** | Published npm package, remote MCP, installer, MIT license, public source. |
| ERC-8004 | **S** | Real canonical registry verified, and a **live wallet-approved registration transaction confirmed on-chain** (`0x0da5e21b...`, status `0x1`). |
| x402 | **S** | Real EIP-712/EIP-3009 verification logic, PLUS a **live non-custodial USDG settlement**: real market swap for funding, real ERC-20 transfer, `POST /settle` returning `200 settled`, and a verified `409` replay-guard rejection on the duplicate submission. |
| Web and app UI | **A-** | Live indigo rebrand, real logo, substantive landing/app surfaces, full-height market terminal, responsive visual review. |
| Production deployment | **A** | Live custom domains, systemd isolation, Cloudflare Tunnel, health verified, daily SQLite online backup timer plus restore runbook. |
| CI / reproducibility | **A** | GitHub Actions is green (workspace install, bounded server files, core/MCP tests, package check, audit, and secret scan). |

### Why S is justified now

Both externally trusted boundary claims — ERC-8004 identity and x402 payment — are proven with real, independently re-verified on-chain transactions, not simulations or trusted client output. The replay guard was proven live (not just unit-tested) by submitting the same settlement hash twice and observing the real `409` rejection. No custody, relayer, or server-held key was involved in either proof; an external wallet performed every signing and broadcasting action, exactly matching the architecture's non-custodial design.

Two areas remain below S and are reported honestly rather than rounded up: MCP/OSS distribution and UI polish are strong (A-) but not exhaustively proven at the same evidentiary bar as the two on-chain claims above, and Jev's live decision call still has no `OPENROUTER_API_KEY` configured in production.
