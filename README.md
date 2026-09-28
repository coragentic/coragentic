# Coragentic

[![npm version](https://img.shields.io/npm/v/@coragentic/mcp)](https://www.npmjs.com/package/@coragentic/mcp)
[![CI](https://github.com/coragentic/coragentic/actions/workflows/ci.yml/badge.svg)](https://github.com/coragentic/coragentic/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](https://github.com/coragentic/coragentic/pulls)

Coragentic is an **agent operating network**: wallet-owned agent identity, private per-agent context, swarm coordination, jobs/offerings, policy-gated tool execution, and audit proof — with Robinhood Chain (EIP-155 chain 4663) as its execution rail.

This repository is the **backend, MCP server, and core runtime** — the API, the durable SQLite-backed state machine, the ERC-8004 identity integration, and the x402 payment verification facilitator. The production frontend (Vite/React) is deployed directly to Cloudflare Pages from a separate, private working tree and is not published in this repository.

Hosted deployment:

- Web app: [coragentic.app](https://coragentic.app)
- API: `https://api.coragentic.app`
- Remote MCP endpoint: `https://mcp.coragentic.app`
- MCP npm package: [`@coragentic/mcp`](https://www.npmjs.com/package/@coragentic/mcp)

## Current state

### Implemented in this checkout

- Local SQLite storage at `data/coragentic.sqlite` by default (override with `CORAGENTIC_DB`).
- Wallet challenge/signature sessions; only token hashes are stored.
- Durable agent **drafts**, memory with SQLite FTS5 keyword retrieval, offerings/jobs, audit events, swarm state, and worker leases.
- API health/network routes, A2A-style agent-card endpoints, MCP discovery manifest endpoints, and read-only market quote/swap-preview helpers.
- Unsigned swap calldata previews; an external wallet must review, sign, and broadcast.
- Deterministic core-runtime policy/allowlist primitives and a separate MCP server (stdio + Streamable HTTP).
- **ERC-8004 Trustless Agents identity registry integration**: the deployed `IdentityRegistry` at `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` on Robinhood Chain is the same canonical singleton address used across every ERC-8004 chain. Its ABI is vendored from the official [`erc-8004/erc-8004-contracts`](https://github.com/erc-8004/erc-8004-contracts) repository and cross-checked against live `name()`/`symbol()` reads. `GET /v1/agents/:id/registration-call` returns unsigned `register(string)` calldata for the owner's external wallet to sign and broadcast; Coragentic never holds a private key or submits the transaction itself.
- **x402 payment verification and non-custodial settlement on Robinhood Chain**: `server/x402-facilitator.mjs` verifies EIP-3009 `transferWithAuthorization` payments in **USDG** (`0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168`) against its live EIP-712 domain, amount/payTo/time window, and on-chain `authorizationState()` replay state. `POST /v1/offerings/:id/verify-payment` performs that authorization verification. For settlement, `POST /v1/offerings/:id/settle` receives a payer-submitted transaction hash and independently verifies the successful ERC-20 USDG `Transfer` receipt on-chain, then atomically records that hash to reject replay. The payer signs and broadcasts their own transfer; Coragentic never holds a key, signs, broadcasts, or runs a gas-funded relayer.
- **$CORA token contract (verified on-chain)**: `0x5c7315710d5bfff95c3d681ca30c327f33deda99` on Robinhood Chain (EIP-155 4663). Direct ERC-20 reads return `name=Coragentic`, `symbol=CORA`, and `decimals=18`. $CORA is not required for the app, API, or MCP; this repository makes no investment recommendation or price claim.

### Explicitly not implemented

- Hosted CLI/SDK publish beyond the current `@coragentic/mcp` package, or an external service SLA.
- Private-key custody, signing, or automatic transaction broadcast anywhere in the codebase. x402 settlement remains non-custodial: the payer broadcasts the transfer, while Coragentic only verifies its receipt and records replay protection.
- Distributed rate limiting, distributed spend accounting, or a managed worker queue.

An agent created through the API is `status: "draft"` until its owner submits the registration transaction externally. Identity responses report `onchain: false` for unregistered agents; registry addresses in responses are metadata, not proof of a submitted transaction.

## Run locally

Prerequisite: a current Node.js runtime with `node:sqlite` support (Node 22.5+; this repository is developed and deployed on Node 26).

```bash
npm install
npm run api       # API: http://127.0.0.1:8787

curl http://127.0.0.1:8787/health
curl http://127.0.0.1:8787/v1/network
```

This repository does not include the frontend. To build a client against this API, target `VITE_API_URL` (or an equivalent) at your running instance and use the routes documented below and at `https://coragentic.app/docs`.

Useful server configuration:

```text
PORT=8787
CORAGENTIC_DB=data/coragentic.sqlite
ROBINHOOD_RPC_URL=https://…
RATE_LIMIT_PER_MINUTE=120
CORS_ORIGINS=http://localhost:5173,https://your-origin.example

# Optional: inject the OpenRouter TypeSafe Jev Decisions adapter in server code.
# It stays offline unless OPENROUTER_API_KEY is set; never commit this key.
OPENROUTER_API_KEY=...
CORAGENTIC_JEV_MODEL=typesafe/jev-1.13
CORAGENTIC_JEV_TIMEOUT_MS=1000

# Worker only; use a file: URL; the executor module must default-export an async function.
CORAGENTIC_JOB_EXECUTOR=file:///absolute/path/to/executor.mjs
CORAGENTIC_WORKER_INTERVAL_MS=2000
CORAGENTIC_WORKER_ID=worker_local
```

To opt in from server-side composition code, import `createOpenRouterJevAdapterFromEnv` from `server/jev-openrouter.mjs` and pass its result where a `createDecisionAdapter`-compatible adapter is accepted. It only sends the explicit `input.state` supplied to each decision; missing credentials, invalid provider results, and request failures retain the deterministic offline fallback.

Start the optional worker only with an explicit executor:

```bash
CORAGENTIC_JOB_EXECUTOR=file:///absolute/path/to/executor.mjs npm run worker
```

The worker claims `accepted` jobs from the configured SQLite database, executes that local module, and submits its returned deliverable. It is not a hosted queue or a payment/delivery guarantee. Check `GET /health/worker` before enabling it; it returns only configured/ready state and a stable reason code. The deployment-safe module contract and systemd template are in [`deploy/EXECUTOR-CONTRACT.md`](deploy/EXECUTOR-CONTRACT.md) and [`deploy/coragentic-worker.service`](deploy/coragentic-worker.service).

## Documentation

The hosted docs are at [`coragentic.app/docs`](https://coragentic.app/docs), with deep links at `/docs/:slug`, including:

- `/docs/overview` and `/docs/getting-started`
- `/docs/architecture`, `/docs/agents`, `/docs/runtime-policy`, `/docs/private-context`, and `/docs/swarm-decisions`
- `/docs/offerings-jobs`, `/docs/market-swap`, and `/docs/mcp-a2a`
- `/docs/security`, `/docs/self-hosting-testing`, `/docs/cora-token`, and `/docs/api-reference`

The manual is grounded in `server/index.mjs`, its server modules, and the workspace packages; it identifies current boundaries rather than treating planned work as shipped functionality. A system design document covering architecture and request/data flow is in [`CORAGENTIC-SDD.md`](CORAGENTIC-SDD.md).

## HTTP surface

Public/discovery routes include:

```text
GET /health
GET /health/worker
GET /v1/network
GET /v1/agents
GET /v1/agents/:id
GET /v1/agents/:id/registration
GET /v1/agents/:id/identity
GET /.well-known/agent.json
GET /a2a/agents/:id
GET /mcp/manifest.json
GET /.well-known/mcp.json
```

Authenticated routes use `Authorization: Bearer <session-token>`. Obtain a session by POSTing a wallet to `/v1/auth/challenge`, signing the returned message off-chain, then POSTing `wallet`, `nonce`, and `signature` to `/v1/auth/verify`. The full route behavior and limits are documented at `/docs/api-reference`.

## Checks

```bash
npm test
npm run test:core
npm run pack:check
```

`npm test` runs the server tests (including documentation-route catalogue coverage), then the core workspace tests/package check and MCP workspace tests. This repository has no frontend to lint or build; the frontend project runs its own `npm run lint`/`npm run build` separately.
