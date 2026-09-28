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

## Current score — **A- overall**

| Area | Grade | Evidence / limitation |
|---|---:|---|
| Runtime, policy, and audit | **A** | Deterministic primitives, bounded inputs, durable audit state, test coverage. |
| Private context and swarm | **A** | Owner-scoped FTS5, bounded context, durable run/step state, decision provider provenance. |
| MCP and OSS distribution | **A-** | Published npm package, remote MCP, installer, MIT license, public source. |
| ERC-8004 | **A-** | Real canonical registry verified and unsigned calldata tested; no user-signed registration receipt yet. |
| x402 | **A-** | Non-custodial direct-transfer verification/settlement implementation and tests; no user-funded production receipt proof yet. |
| Web and app UI | **A-** | Live indigo rebrand, real logo, substantive landing/app surfaces, responsive visual review. |
| Production deployment | **A** | Live custom domains, systemd isolation, Cloudflare Tunnel, health verified, daily SQLite online backup timer plus restore runbook. |
| CI / reproducibility | **A** | GitHub Actions is green for `fefa98d`: workspace install, bounded server files, core/MCP tests, package check, audit, and secret scan. |

### Why it is not S

S requires a reproducible clean CI run **and** at least one wallet-approved proof for the two externally trusted boundary claims: an ERC-8004 registration receipt and/or a real non-custodial USDG settlement receipt. Their absence is not a reason to fake a claim; the code is designed so an external wallet—not the server—must perform those actions.

### Highest-value next gates

1. Fix the GitHub Actions hang/cancellation and capture a green run.
2. Submit one owner-approved ERC-8004 registration transaction and store its receipt as public proof.
3. Submit one owner-funded USDG direct transfer, call `/settle` with its hash, and retain the resulting auditable event/receipt proof.
4. Add a backup/restore drill and a single-node SQLite recovery runbook before calling deployment operations S-tier.
