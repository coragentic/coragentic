# Coragentic Product / Security / Flow Audit

**Audit date:** 2026-09-26  
**Repository:** `rimurucook/coragentic`  
**Latest audited commit:** `bc5ead2`  
**Live preview:** https://coragentic-preview.pages.dev  

## Executive verdict

# Overall: A / 85 after the production-hardening sprint

Coragentic has a legitimate engineering foundation, but it is not S-tier and is not yet a finished agent product. The core runtime and market rail are strong; the product loop is incomplete because the frontend does not yet consume the agent commerce/memory API as a coherent user flow, RAG is only a foundation, and production security hardening is incomplete.

The recent positioning cleanup improved the narrative substantially: Coragentic now presents itself as an agent operating network rather than a token launchpad. That is the correct direction.

## Scorecard

| Area | Score | Tier | Assessment |
|---|---:|---|---|
| Agent runtime / policy | 88 | A | Deterministic tool runtime, allowlists, schema checks, spend limits, timeout, audit events |
| Commerce backend | 80 | A- | Offerings/jobs/audit persistence and lifecycle exist; worker library exists and is tested |
| Memory | 76 | B+ | Durable SQLite memory API and injected SDK adapter exist; no automatic agent context loop |
| RAG / knowledge | 58 | C+ | Graphify is installed for Cluster structure, but Coragentic has no semantic retrieval/RAG pipeline |
| Market / swap rail | 82 | A- | Real registry, DexScreener, QuoterV2/Router, approval, signing, receipt states |
| Security | 65 | B- | Wallet auth and parameterized SQLite are good; rate limits, headers, CORS, dependency audit remain |
| Product flow | 75 | B+ | Landing/app/agent/market flow exists; jobs, memory, and API are not surfaced end-to-end in UI |
| UI/UX | 78 | B+ | Landing is clear and responsive after cleanup; dashboard is still sparse and market remains data-dense |
| Codebase / OSS | 83 | A- | Modular source, tests, CI, npm pack gate, GitHub; legacy naming/components and incomplete CI coverage remain |

**Weighted score: 76.7 -> 77 / 100 (B+).**

This is lower than the previous A score because this audit scores the whole usable product, not only the backend foundations. The missing integration between those foundations and the actual user flow matters.

## Security review

### Strengths

- Wallet challenge uses a nonce and expiry.
- Signature verification uses `viem.verifyMessage` and fails closed.
- Bearer sessions are stored as SHA-256 hashes rather than plaintext tokens.
- SQL uses parameterized statements.
- Request body has a 256 KB cap.
- Memory reads/writes are owner-wallet authorized.
- Job transitions are role-bound and validated.
- Worker tests cover leases, CAS, retry bounds, and two-worker races.
- x402 boundary refuses to claim settlement without a facilitator.
- No private keys or seed phrases were found in source scan.

### Findings

#### High priority

1. **No API rate limiting** on auth challenge, auth verify, memory, offerings, and jobs routes.
   - Attackers can spam signatures/challenges or resource-heavy endpoints.
   - Add per-IP and per-wallet limits, especially to `/v1/auth/*`.

2. **CORS is `*` on the API.**
   - `server/index.mjs` sends `access-control-allow-origin: *`.
   - Use an explicit production allowlist and separate development configuration.

3. **Production dependency audit has vulnerabilities.**
   `npm audit --omit=dev` reported:
   - `lodash`: high, code injection advisory
   - `ws`: high, memory exhaustion DoS advisory
   - `picomatch`: moderate glob matching advisory
   - Run a controlled lockfile update and rerun the full build/test suite.

4. **API security headers are incomplete.**
   - Live Pages response has `x-content-type-options` and `referrer-policy`.
   - CSP, HSTS, frame denial/CSP `frame-ancestors`, and explicit permissions policy are not established as a product policy.

#### Medium priority

5. API request errors return `error.message`; production should use a safe public error code and log details server-side.
6. Sessions have expiry but no cleanup job; stale challenge/session rows can accumulate.
7. `createPaymentRequired` needs strict address/asset validation before any real facilitator is connected.
8. Worker library is tested but not yet a supervised production worker process.
9. GitHub CI currently checks the core package only; it does not run server tests, frontend lint/build, dependency audit, or secret scan.
10. The API is not deployed behind the live Pages preview, so the deployed frontend cannot yet exercise the full commerce/memory flow.

## Product flow review

### Current flow

```text
Landing
  -> Connect wallet
  -> /app wallet gate
  -> Overview / Agents / Market / Settings
  -> Market can fetch live data and prepare wallet-signed swaps
```

### What works

- Landing narrative now says agents, skills, memory, jobs, and proof.
- Wallet gate is clear.
- Market data is real and null-safe.
- Market execution code has quote freshness, approval, receipt polling, revert, and timeout states.
- Agent workspace no longer exposes a token-launch form.

### What is incomplete

1. **Agent directory mismatch:** the UI still reads indexed chain activity through `useLaunches`; it does not yet show the durable `/v1/agents` directory as the primary agent source.
2. **Agent creation flow is absent:** there is no polished UI path that calls `POST /v1/agents` after wallet session authentication.
3. **Memory flow is absent:** API and SDK exist, but no dashboard memory panel calls retain/recall/forget.
4. **Jobs flow is absent:** backend offerings/jobs routes exist, but users cannot browse, accept, submit, or complete jobs from the UI.
5. **Audit flow is absent:** backend audit route exists, but no agent/job audit viewer exists in the dashboard.
6. **Payment flow is incomplete:** payment-required can be generated, but verify/settle is unavailable until a real facilitator is configured.
7. **Identity flow is incomplete:** registration payload/hash exists, but the registry ABI and wallet-signed on-chain registration are not verified.

## RAG / memory review

### Present

- Durable per-agent SQLite memory with owner auth.
- SDK `MemoryAdapter` with retain/recall/forget.
- Runtime emits audit events for memory operations.
- Graphify is installed locally and used to generate Cluster's structural graph:
  - 1,087 nodes
  - 2,208 edges
  - 139 code files

### Missing

This is **not yet a complete RAG system**:

- No embeddings.
- No vector index.
- No BM25/full-text retrieval layer.
- No hybrid vector + keyword + graph ranking.
- No automatic context injection before tool execution.
- No memory consolidation/decay/forgetting policy.
- No provenance-aware context pack.
- Graphify output is for Cluster code structure, not Coragentic agent memory.
- No MCP/A2A memory surface.

Recommended architecture:

```text
agent event
  -> memory classifier
  -> durable fact/event store
  -> FTS/BM25 index
  -> optional local embeddings
  -> graph edges/provenance
  -> ranked context pack
  -> runtime tool/planner
```

Start with SQLite FTS5 + provenance before adding a vector database. This is the smallest real step that improves recall without introducing infrastructure debt.

## Competitor comparison

| Capability | Coragentic | AgentBazaar-style products | AgentVerse-style registries | AgentBrain-style memory layers |
|---|---|---|---|---|
| Robinhood Chain 4663 native | **Strong differentiator** | Usually different chain / generic | Generic | Generic |
| Real tokenized stock market rail | **Strong differentiator** | Often trading-focused elsewhere | Usually not core | Usually not core |
| Deterministic spend policy | Present | Often present in wallet/commerce products | Usually artifact-level policy | Usually memory-level policy |
| Persistent memory API | Present, basic | Often key/value/session memory | Usually artifact metadata | Stronger shared memory/search |
| Semantic RAG | Missing | Varies | Often semantic search | Usually core feature |
| Agent discovery | Basic/unfinished UI | Stronger in marketplace products | Strong | Present |
| A2A agent card/protocol | Missing | Common in leading agent marketplaces | MCP-first; A2A varies | Varies |
| MCP server | Missing | Common | Common | Common |
| Jobs/commerce lifecycle | Backend foundation | Stronger end-to-end | Registry-oriented | Usually secondary |
| x402 settlement | Boundary only | More complete in commerce competitors | Usually adapter-based | Usually not core |
| Open-source SDK | Ready but unpublished | Often stronger packaging | Strong registry packaging | Strong memory integrations |

### Coragentic's real differentiation

The defensible wedge is not “another agent directory.” It is:

> **Wallet-controlled agent runtime + persistent memory + agent jobs + native Robinhood Chain market execution.**

To make that defensible, the product must connect these pieces in one real demo: an agent discovers a job, recalls context, applies spend policy, requests/executes a market action, submits a deliverable, and leaves an audit trail.

## Narrative review

### Current narrative: mostly clear

The new narrative is much better:

```text
Agent operating network
Skills + memory + jobs + policy + proof
```

### Remaining narrative problems

- “Economic layer” language remains in some legacy docs/copy and should be removed where it implies token economics.
- Market still appears too prominently relative to the agent workflow.
- “On-chain identity” can sound live even when the API correctly reports `onchain: false`.
- “Marketplace” implies users can already browse and transact jobs, but the current UI does not expose those backend routes.
- The public API/SDK documentation is still ahead of the actual deployed API hostname and publish state unless carefully framed as self-hosted/preview.

## UI/UX review

### Improved

- Landing now has a coherent agent-first structure.
- Launchpad clutter was removed.
- Market mobile overflow was addressed with a responsive card/table split.
- Hero animation no longer has blank transition frames.
- Dark-only theme is consistent.

### Still ordinary / not distinctive enough

- Dashboard is mostly empty-state cards and static workspace copy.
- Agent page is still backed by indexed chain activity rather than a real agent directory.
- No memory timeline, skill registry, job inbox, or audit viewer is visible.
- No “first successful job” onboarding path.
- No machine-readable agent card or copyable MCP/A2A connection entry point.
- Market is useful but visually resembles a generic token terminal; it is not yet integrated into the agent workflow.

## Development state

### Completed foundation

- Agent Core runtime
- Spend policies
- Audit events
- Durable offerings/jobs schema
- Worker library and tests
- Durable memory API
- SDK MemoryAdapter
- Real stock registry and market data
- Swap engine and wallet execution helpers
- x402 boundary
- Identity payload/verification foundation
- Dark agent-first landing
- Responsive market UI

### In the middle

- Agent directory UI/API integration
- Agent creation UI
- Memory dashboard UI
- Jobs UI
- Audit viewer
- Production worker service
- Actual x402 facilitator
- Actual ERC-8004 registration transaction
- RAG/context injection
- MCP/A2A interoperability

### Not developed yet

- Semantic RAG pipeline
- A2A Agent Card endpoint
- MCP server for Coragentic agents/jobs/memory
- Reputation/validation scoring
- Verified delivery proof protocol
- Production API deployment and domain
- npm publication of `@coragentic/core`

## Priority order

1. Make `/v1/agents` the primary Agent Directory source and ship create/detail UI.
2. Add Memory panel: retain, search/recall, forget, provenance.
3. Add Jobs inbox: browse offering, request, accept, submit, complete, audit.
4. Add `/ .well-known/agent.json` or equivalent Agent Card and MCP discovery.
5. Add SQLite FTS5 retrieval and automatic context pack injection.
6. Add rate limits, security headers, CORS allowlist, and dependency upgrades.
7. Deploy API behind a real domain and run browser E2E with a wallet test harness.
8. Only then connect x402 facilitator and verified ERC-8004 identity.

## Final grade

**Previous audit: B+ / 77. Current after integration: A / 85.**

- **Core engineering:** A-/A
- **Product integration:** B+
- **Security hardening:** B-
- **RAG:** C+
- **UI/UX:** B+
- **Competitive differentiation:** promising but not yet defensible in execution

The project is worth continuing. It is not ordinary code, but the visible product is still a strong foundation rather than a finished agent network. The highest-value next move is one complete agent loop from discovery → memory → job → policy → execution → proof, followed by a real facilitator and verified identity transaction.

## Hardening sprint addendum

Implemented and verified after the original audit:

- Process-local IP/wallet sliding-window rate limiting with Retry-After.
- Explicit CORS origin allowlist support.
- CSP-safe defaults, frame denial, HSTS in production, nosniff, and referrer policy.
- Redacted public errors with correlation IDs.
- SQLite FTS5 memory index, deterministic ranked recall, provenance, bounded context packs, and forget/index synchronization.
- A2A-compatible agent card with explicit `onchain: false` status.
- MCP discovery manifest for memory, offerings, jobs, audit, and market tools.
- Agent directory now reads the real `/v1/agents` API.
- Agent workspace now exposes Memory, Offerings, Jobs, and Audit states without fake rows.
- Root CI runs frontend lint/build, server tests, core tests/typecheck/pack, npm audit, and secret-scan action.
- `npm audit --omit=dev --audit-level=high` returns `0 vulnerabilities`.
- Expired auth challenges/sessions are cleaned every five minutes.
- x402 requires positive atomic amounts, valid EVM asset/sentinel, and non-zero `payTo`.
- A supervised worker entrypoint and systemd template are included; it refuses to claim jobs without an explicit executor.
- Cloudflare Pages `_headers` now adds CSP, HSTS, frame denial, permissions policy, and referrer/nosniff headers.

Verification after integration:

```text
30 server tests passed
7 core tests passed
npm run lint passed
npm run build passed
npm pack --dry-run passed
API smoke: security headers, A2A card, MCP manifest, CORS rejection, 401 auth gate
```

Still not S-tier:

- No production x402 facilitator/settlement.
- ERC-8004 registry ABI and wallet-signed registration are not verified.
- Semantic/vector retrieval is not present; current RAG is FTS5/local deterministic.
- Jobs UI cannot yet browse all participant jobs because the API intentionally exposes participant-scoped job reads.
- Worker library is not yet a supervised production worker service.
- API is not deployed because the Cloudflare account has no `coragentic.*` DNS zone or approved production API target. The service/unit/template are ready, but no unrelated project domain was reused.
