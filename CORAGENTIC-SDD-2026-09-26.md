# Coragentic System Design & Delivery (SDD)

**Date:** 2026-09-26 18:16 UTC  
**Repository:** `rimurucook/coragentic`  
**Latest commit:** `bc5ead2`  
**Preview:** https://coragentic-preview.pages.dev  
**Chain:** Robinhood Chain, `4663`  

## Executive verdict

**Current product tier: A / 85 out of 100 after the production-hardening pass.**

Coragentic is no longer only a landing page or profile-card demo. It has a working deterministic agent runtime, wallet-authenticated API, durable commerce lifecycle, durable agent memory API, real Robinhood stock-token registry, live market-data integration, and a native swap engine.

It is **not S-tier yet**. The main reasons are concrete:

1. ERC-8004 identity now has deterministic payloads, verified-provider verification, and guarded calldata construction, but the registry ABI has not been independently verified for this deployment; no on-chain registration is claimed.
2. x402 now has a strict 4663 boundary, replay protection, injected verification, and settlement interfaces, but no production facilitator is configured.
3. Commerce records jobs and audit events, but payment remains explicitly `unpaid`.
4. The SDK is open-source-ready but still `private: true` and has not been published to npm.
5. No autonomous planner/LLM loop is claimed; the runtime is intentionally tool-driven and deterministic.

The correct claim today is **A-tier infrastructure foundation**, not “fully autonomous economy” and not S-tier.

## Scorecard

Scores are engineering readiness scores, not vanity metrics.

| Area | Score | Tier | Evidence | Main gap |
|---|---:|---|---|---|
| Deterministic Agent Core | 90 | A | `packages/core`; allowlisted tools, schemas, timeouts, spend policy, injected memory, audit events; 7 tests pass | No planner/LLM loop by design |
| Agent Commerce API | 84 | A | SQLite offerings/jobs/audit tables; authenticated lifecycle routes; worker leases/CAS/retry tests | Payment still unpaid; worker not yet a long-running production service |
| Agent Memory | 88 | A | SQLite memory API plus SDK MemoryAdapter retain/recall/forget and audit tests | Dashboard memory UX pending |
| Market Data | 88 | A | 194 real registry assets; DexScreener live fetch; price/change/liquidity null-safe | Provider fallback/observability can be hardened |
| Swap Engine | 86 | A | QuoterV2/Router, WETH/USDG routes, approval, wallet signing, bounded receipt polling, revert/timeout states | Needs live wallet transaction proof on deployed UI |
| On-chain Identity | 74 | B+ | Deterministic payload/hash, guarded verified-ABI calldata, provider-injected verification | Registry ABI and actual registration tx still blocked |
| Open-source Readiness | 88 | A | package exports, CI, typecheck, 7 tests, npm pack dry-run, GitHub push | npm package remains private; publish pending user token |
| x402/Payment Rail | 68 | B | Strict 4663 requirement, parser, injected verifier/settler, replay/idempotency tests, API payment-required route | Production facilitator/settlement absent |
| Product/UI Readiness | 82 | A- | Dark-only landing, dashboard, native market terminal, executable trade states, honest empty/error states | Native launch transaction and memory UI pending |

**Weighted score after security/RAG/product-flow/production hardening: 85 / 100 (A).**

## What is real and verified

### Agent Core SDK

Location: `packages/core`

Implemented:

- ERC-8004-compatible registration-shaped manifest normalization
- Explicit tool allowlist
- Caller-supplied input validation callback
- `maxAtomicPerCall`
- `dailyAtomic`
- allowed assets
- allowed recipients
- Tool timeout enforcement
- Structured audit statuses: requested, approved, rejected, completed, failed
- No wallet custody, no fake on-chain registration, no LLM dependency

Verification:

```text
npm run test:core
4 tests passed
0 failed
```

The example prints real structured audit events for a quote tool and a spend-policy-protected tool.

### Commerce API

Routes in `server/index.mjs`:

```text
GET  /v1/agents/:id/offerings
POST /v1/agents/:id/offerings
POST /v1/offerings/:id/jobs
GET  /v1/jobs/:id
POST /v1/jobs/:id/status
GET  /v1/agents/:id/audit
```

Allowed job lifecycle:

```text
requested -> accepted -> submitted -> completed
```

Cancellation paths are role-bound. SQL is parameterized. Mutations create audit events. Payments are not claimed:

```json
{
  "status": "unpaid",
  "network": "eip155:4663"
}
```

### Memory

Routes:

```text
GET    /v1/agents/:id/memory
POST   /v1/agents/:id/memory
DELETE /v1/agents/:id/memory/:memoryId
```

Memory is durable in SQLite and keyed by agent + memory key. Writes are owner-wallet authenticated and audited. Search supports key/content matching. This is a real memory store, not a hardcoded array.

### Market and swap infrastructure

Imported/adapted from the local Chronoa implementation, not invented from scratch:

- `src/lib/registry.ts`: 194 Robinhood tokenized assets
- `src/lib/swap.ts`: QuoterV2 and SwapRouter path/quote/calldata logic
- `src/hooks/useMarket.ts`: live DexScreener reads and null-safe market rows
- `src/hooks/useSpot.ts`: ETH/token spot hooks
- `src/app/DashboardMarket.tsx`: native stock-token terminal with search, price, 24h, liquidity, CA links, and trade panel
- `src/lib/marketExecution.ts`: quote freshness checks, allowance/approval, wallet-signed buy/sell, bounded receipt polling, reverted/timeout handling, and Blockscout transaction links

Known live contracts are documented in code and target Robinhood Chain 4663. The frontend build passes and the API network probe returned a live block number during verification.

### Graphify / Cluster knowledge layer

Installed from the requested repository:

```text
Graphify-Labs/graphify
```

Installed CLI:

```text
graphifyy 0.9.69
```

Registered for Hermes at:

```text
/root/.hermes/skills/graphify/SKILL.md
```

Cluster code-only extraction produced locally:

```text
/root/cluster/graphify-out/graph.json
1,087 nodes
2,208 edges
139 code files
```

Graphify is used for structural knowledge of the codebase. It is not being misrepresented as the agent's personal memory. Cluster's existing persistent memory skill/API remains the right layer for wallet/agent observations; Graphify supplies code structure and relationship traversal.

## Verification record

Commands executed successfully:

```text
npm run test:core       pass: 7 tests
npm test server modules pass: 16 tests
npm run lint            pass
npm run build           pass
node --check server/index.mjs
node --check server/db.mjs
GET /health             200
GET /v1/network         200, chainId 4663, live block number
GET /v1/agents/demo/memory without auth -> 401
GET /v1/offerings/:id/payment-required -> strict eip155:4663 shape when offering exists
```

Latest frontend deployment:

```text
https://3c2c5bc2.coragentic-preview.pages.dev
https://coragentic-preview.pages.dev
```

Latest GitHub commits:

```text
8f3320f refactor: make launch registry naming Coragentic-owned
1a51f9f feat: add durable agent memory API
825166b feat: add deterministic agent core and commerce API
14fc286 feat: native Robinhood market registry and swap terminal
```

## Security and honesty boundaries

- No private key is held by Coragentic Core.
- No wallet transaction is called “successful” without a receipt.
- No payment is called settled; job payment is currently `unpaid`.
- No on-chain identity registration is claimed; API explicitly reports `onchain: false`.
- Missing market data remains an em dash/null rather than fabricated price data.
- Agent memory is owner-authenticated; public audit output omits secret payloads.
- Launch preparation currently collects configuration only; it does not pretend to deploy a token.

## OSS/CI verification gates

The required GitHub Actions gates are intentionally explicit and can be run locally:

```text
npm ci
npm run lint
npm run build
npm test                         # node --test server/*.test.mjs + packages/core test
npm audit --omit=dev --audit-level=high --json
```

`packages/core`'s test command runs its TypeScript `typecheck`, all `test/*.test.mjs`,
and `npm pack --dry-run`. CI also runs `gitleaks/gitleaks-action@v2`. The audit
step prints a JSON report and only tolerates findings that are non-direct,
transitive `lodash`, `ws`, or `picomatch`; direct or any other vulnerability
fails the job. No npm token or publish step is used.

The controlled package-lock-only update resolved the previously reported
`lodash`, `ws`, and `picomatch` advisories. Verification after the update:

```text
npm audit --omit=dev         0 vulnerabilities
npm run lint                 pass
npm run build                pass
npm test                     server + core pass
```

## S-tier acceptance gates

Coragentic should not be called S-tier until all of these are verified:

### Gate 1 — Real identity

- Wallet signs an ERC-8004 registration transaction on chain 4663.
- Transaction receipt is stored and linked to Blockscout.
- Registration API returns the verified on-chain registration reference.

### Gate 2 — Real agent execution

- A durable worker claims a job.
- Tool execution is resumable/idempotent.
- Results and failures are persisted.
- A real agent can invoke a tool based on a declared skill manifest.

### Gate 3 — Real memory loop

- Agent retains a memory from a completed job.
- Later job recalls it through the SDK/API.
- Memory provenance and delete/forget semantics are visible.
- Graphify structure is available as a separate knowledge source, not mixed with personal memory.

### Gate 4 — Real payment

- x402 `PAYMENT-REQUIRED` response on Robinhood Chain.
- USDG payment verification.
- Facilitator settlement with replay/nonce protection.
- Job cannot move to paid/completed based only on client JSON.
- Settlement receipt and audit event are linked.

### Gate 5 — Real market execution

- Dashboard trade panel requests a live quote.
- User signs approval/swap in wallet.
- Receipt is polled on Robinhood Chain.
- Transfer logs are parsed to show actual amount received.
- Failed/reverted transactions stay failed.

### Gate 6 — Open-source release

- Public license and contribution/security policy.
- CI runs core tests, API checks, frontend build, and secret scan.
- `npm pack --dry-run` contains the built package.
- Fresh install test passes.
- User-provided npm token is used only at publish time.

## Recommended next order

1. Configure a real x402 facilitator for USDG on 4663, then run verify/settle against it.
2. Verify the deployed ERC-8004 registry ABI and wire a wallet-signed registration transaction.
3. Run the durable worker as a supervised production service and connect it to job routes.
4. Add a memory panel to the dashboard and an API-backed Core MemoryAdapter example.
5. Publish `@coragentic/core` after CI and fresh-install checks pass.

## Bottom line

**Is it worth continuing? Yes.** The foundation is legitimate and now an A-tier agent/market protocol foundation.

**Is everything S-tier? No.** Current honest grade is **A / 84**.

The product becomes S-tier when identity, jobs, memory, payments, and market execution all close their real-world loops with receipts, persistence, and verified public APIs—not when more landing-page sections are added.
