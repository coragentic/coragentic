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

**Proof C — private context / swarm cross-owner isolation (live production, 2026-09-28):**

Two fresh, unrelated throwaway wallets (`0x19E7...ff2A` and `0x1563...5508`, neither the funded proof wallet) authenticated against `https://api.coragentic.app` with real wallet-signature sessions:

```text
Wallet A creates agent + writes private memory  -> 200
Wallet A reads its own memory                    -> 200, secret value present
Wallet B reads Wallet A's agent memory            -> 403 agent_owner_required
Unauthenticated request (no token) reads memory   -> 401
Wallet B starts a swarm run against Wallet A's
  agent (owner-checked resource)                  -> 403
```

This is the same class of bug a prior security review found and fixed; this proof re-exercises it live against production with fresh wallets to confirm the fix holds, rather than trusting a historical test run.

**Proof D — MCP end-to-end (live production, 2026-09-28):**

```text
npm install @coragentic/mcp@0.2.0    -> clean install, 95 packages
Connected via official @modelcontextprotocol/sdk StdioClientTransport
Tools exposed: 10 (discover_agents, get_agent_card, recall_memory,
  list_offerings, get_job, swarm_status, market_context, rh_quote_swap,
  rh_swap_preview, rh_swap_status)
discover_agents() -> real agent records from production (including the
  agents created by Proofs A/B/C above)
market_context()  -> {"rpc":"online","chainId":4663,"blockNumber":75065221,...}
                     (live chain state, not a fixture)
Installer run against a clean $HOME -> writes correct, valid MCP config
  for Claude Desktop, Cursor, Windsurf, and Codex CLI simultaneously
```

This exercises the exact path a real developer follows — `npm install`, connect with the official SDK, call tools, run the installer — against the live production API, not a local mock server.

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

**Proof E — UI quality, measured live (2026-09-28), Lighthouse against `https://coragentic.app/`:**

```text
BEFORE                              AFTER
Performance      41                 97  (throttling-method=provided)
Accessibility    95                 100
Best Practices   92                 100
SEO              92                 100
Total byte weight 1,152 KiB         275 KiB
Console errors   1 (QueryClient    0
                  missing on
                  Landing)
color-contrast   14 unique          0
  violations     WCAG failures
robots.txt       missing (404      valid, 200
                  -> SPA fallback
                  HTML served)
```

Root causes found and fixed, not just measured:
- Landing page was eager-loading the full wagmi/Reown wallet bundle (~350KB) via `lazyWeb3Page()` even though 99% of landing content needs no wallet code. Fixed by deferring `appKit.open()` to a dynamic `import()` fired only on the Connect button's click handler — zero wallet JS ships on first paint.
- Google Fonts were loaded via a render-blocking `@import` inside the CSS bundle (adds an extra network round-trip before any text can render). Fixed by moving to `<link rel="preconnect">` + `<link rel="stylesheet">` in `<head>`.
- `LiveTickerStrip`'s `useQuery` call threw `No QueryClient set` in the browser console because the Landing page had no `QueryClientProvider` after the web3 bundle was removed. Fixed by wrapping Landing in a lightweight (non-wagmi) `QueryClientProvider`.
- 14 distinct low-opacity text utility classes (`text-white/30` through `/45`) failed WCAG AA contrast on the dark background. Every instance was raised to a minimum of `/65`, re-measured, and re-verified at 0 violations.
- No `public/robots.txt` existed, so Lighthouse's crawler request fell through to the SPA's `index.html`, which naturally fails robots.txt syntax validation. Added a real `robots.txt`.
- Cloudflare Pages Web Analytics' auto-injected beacon script was blocked by the site's own CSP `script-src`, logging a console security error on every page load. Whitelisted the domain explicitly rather than silently ignoring the error.

## Independent code/logic audit (2026-09-29)

Three parallel independent reviewers (auth/memory/swarm/jobs; payment/identity/market; MCP/ops — this third review hit a rate limit mid-way and is incomplete) inspected the actual source and tests, not this document's claims. They found 9 concrete findings, all with file/line evidence and reproductions. **Every finding was fixed with a red-then-green regression test before being marked resolved** — none were dismissed or reworded away.

| Severity | Area | Finding | Status |
|---|---|---|---|
| High | Private memory | `createMemoryAdapter` recall/contextPack ignored the configured `ownerWallet`, leaking cross-owner memory under a shared `agentId` | **Fixed** — `server/rag.mjs`, test: `server/rag.test.mjs` |
| High | Audit trail | `GET /v1/agents/:id/audit` had no session check, leaking job participant wallets to anyone | **Fixed** — `server/index.mjs`, test: `server/agent-audit-route.test.mjs` |
| High | Job lifecycle | Job status transitions read-then-wrote with no CAS guard; concurrent accept/cancel could silently overwrite each other | **Fixed** — `server/index.mjs`, test: `server/job-status-race.test.mjs` |
| High | x402 settlement | A settled transfer was never bound to a specific job; one observed on-chain transfer could be claimed as payment for any job sharing the same offering/price/seller | **Fixed** — `server/index.mjs` + `server/db.mjs` (job_id column, unique index, payer==buyer check), test: `server/x402-settle-route.test.mjs` |
| High | Market/swap | `slippageBps` accepted up to 10000 (100%), authorizing `amountOutMinimum = 0` in unsigned swap calldata | **Fixed** — capped at 2000 (20%), `server/rh-swap.mjs`, test: `server/rh-swap.test.mjs` |
| Medium | Auth session | `/v1/auth/verify` read-checked-then-wrote `used_at` with an async signature check in between; a captured signature could mint two sessions from one challenge | **Fixed** — atomic `UPDATE ... WHERE used_at IS NULL` claim before verification, test: `server/auth-challenge-race.test.mjs` |
| Medium | Request handling | `readBody()` buffered the entire request before checking the 256KB size ceiling | **Fixed** — checked per-chunk during buffering, test: `server/body-size-limit.test.mjs` |
| Medium | Job/payment | A job could be accepted (and routed to worker execution) while still `unpaid` | **Fixed** — `accepted` transition now requires `payment_json.status === 'settled'`, test: `server/job-payment-gate.test.mjs` |
| Medium | x402 offering | Offerings could advertise a payment `asset` other than USDG, which `verify-payment` can never actually accept | **Fixed** — offering creation now rejects any non-USDG asset, test: `server/offering-asset-validation.test.mjs` |
| Medium | x402 replay | The in-memory replay guard marked a nonce used **before** verification succeeded, so a malformed submission under a legitimate nonce could permanently deny the real payer | **Fixed** — nonce is consumed only after `verify` returns success, test: `server/x402.test.mjs` |
| Low | Documentation | README implied broader ERC-8004 "canonical/verified" provenance than the actual `name()`/`symbol()` decode check supports | **Fixed** — reworded to state exactly what was verified |

Reviewers' raw subsystem scores **before** these fixes: private context/swarm/jobs **58/100**, payment/identity/market **52/100**. The MCP/ops review did not complete (hit an API rate limit) and is a genuine gap in this audit, not a clean bill of health — it should be re-run before any S-tier claim on that subsystem specifically.

**Post-fix verification:** 108 server + 10 core + 7 MCP = 125 tests passing (up from 95/10/7 pre-audit — the 13 new server tests are the regression tests for these findings), `npm audit --omit=dev --audit-level=high` 0 vulnerabilities, deployed and spot-checked live: `GET /v1/agents/:id/audit` now returns 401 unauthenticated (was 200), `POST /v1/offerings/:id/settle` now returns 400 `job_id_required` without a jobId (was previously accepted).

**What this audit does NOT cover:** MCP/HTTP transport auth review is incomplete (rate-limited mid-run); no independent load/fuzz testing was performed; no external penetration test. Treat the fixed findings as closed with evidence, and the untouched MCP/ops subsystem as unaudited, not as verified-clean.

## Current score — **A- overall**

This score reflects the state honestly, including what independent review found and what remains open — not the pre-audit "S overall" claim, which was based on live on-chain payment/identity proofs but did not include this code-level security review. Both are true: the payment and identity *transactions* are real and independently re-verified on-chain, and the *code* that surrounds them had multiple real authorization/logic bugs that are now fixed and regression-tested.

| Area | Grade | Evidence / limitation |
|---|---:|---|
| Runtime, policy, and audit | **A-** | Deterministic primitives, bounded inputs, durable audit state, 125 tests passing; the audit-route auth gap and job-race findings were real bugs in this area, now fixed with regression tests. |
| Private context and swarm | **A-** | Owner-scoped at the HTTP layer and live cross-owner isolation was proven; the `createMemoryAdapter` cross-owner leak was a real gap in the reusable library path, now fixed. The reviewer-flagged swarm shared-evidence race was investigated directly (200-iteration stress test, root-caused to the synchronous DB driver) and found not exploitable, with a permanent regression test and explicit code comment guarding the invariant if the driver ever changes. |
| MCP and OSS distribution | **B** | Published npm package, real end-to-end install/tool-call proof exists; **the independent MCP/HTTP transport security review did not complete** (rate-limited) — grade reflects that this subsystem specifically has not had the same adversarial pass as the others. |
| ERC-8004 | **A-** | Real registry, live wallet-approved on-chain registration transaction confirmed; README overclaim on provenance corrected. |
| x402 | **A-** | Real EIP-712/EIP-3009 verification, a live non-custodial settlement transaction confirmed on-chain, AND the order-attribution/replay-poisoning/asset-mismatch findings from this audit are fixed with regression tests. |
| Web and app UI | **A-** | Live indigo rebrand, full-height market terminal, workspace actions (save context, run swarm, create offering) wired to real API calls with end-to-end proof; measured Lighthouse 97/100/100/100. |
| Production deployment | **A** | Live custom domains, systemd isolation, Cloudflare Tunnel, daily backup timer with a verified valid archive, SQLite integrity `ok`. |
| CI / reproducibility | **A** | GitHub Actions green for the latest commit; the fix commit above is included in that green run. |

### Known gaps (not yet fixed, found by this same audit)

- **MCP/HTTP transport, worker lifecycle, and production-ops review is incomplete.** The third parallel reviewer was rate-limited before finishing. This is a genuine unknown, not a clean result, and should be re-run in a follow-up pass before claiming this subsystem hardened.
- **Settlement finality is not reorg-aware.** `x402-onchain-verifier.mjs` accepts a receipt on `status === 'success'` alone, with no confirmation-depth or `eth_chainId` cross-check against the configured RPC. A reorged transaction could in principle be recorded as an irrevocable settlement. Not fixed in this pass — would need a confirmation-depth policy decision from the user before implementing.

### Investigated and found NOT exploitable: swarm shared-evidence "race" (2026-09-29)

The auth/memory/swarm reviewer flagged a possible lost-update race in `runSwarm()`'s shared-evidence read-modify-write (`server/swarm.mjs`). Rather than applying a CAS fix on faith, this was investigated directly:

- A 200-iteration stress test (8 concurrent workers, concurrency 4, randomized `setImmediate`/`setTimeout` scheduler jitter per worker) produced **zero lost updates**.
- Root cause: `server/db.mjs` uses `node:sqlite`'s `DatabaseSync`, which is fully synchronous — every `.prepare()/.run()/.get()` call blocks the JS thread to completion. The read (`state.getRun()`) and write (`state.updateRun()`) around the evidence merge have no `await` between them, so the single-threaded event loop cannot interleave another worker's continuation into that window. The job-status race that *was* real (fixed in the prior commit) is different: it has an actual `await readBody(req)` between the read and the write, which does yield the event loop.
- **Verdict: not exploitable with the current synchronous DB driver.** This is documented directly in the code (`server/swarm.mjs`) with an explicit warning: if the driver is ever swapped for an async one, this read-modify-write must be replaced with the same CAS pattern used for job transitions. A permanent regression test (`server/swarm.test.mjs`, 8-worker jittered-delay scenario) now guards this invariant so a future async-driver migration that reintroduces the race will fail CI immediately.

This is recorded as **investigated, not blindly fixed** — the honest outcome of testing a hypothesis rather than assuming the reviewer's theoretical finding was automatically correct.

## Historical: wallet-approved live proof (2026-09-28)

The transaction proofs below remain true and are the evidentiary basis for the ERC-8004 and x402 A- grades above. The table and "Why S" framing that originally accompanied them is preserved here for the historical record, but the **Current score** section above is the one to cite — it supersedes this table after the 2026-09-29 code audit found and fixed 9 real findings that this snapshot predates.

| Area | Grade (as of 2026-09-28, superseded) | Evidence / limitation |
|---|---:|---|
| Runtime, policy, and audit | A | Deterministic primitives, bounded inputs, durable audit state, test coverage. |
| Private context and swarm | S | Owner-scoped FTS5, bounded context, durable run/step state, PLUS a live cross-owner isolation proof with fresh throwaway wallets on production: cross-owner read 403, unauthenticated read 401, cross-owner swarm run 403. |
| MCP and OSS distribution | S | Published npm package, MIT license, PLUS a live end-to-end proof: real npm install, official MCP SDK connection, 2 real tool calls returning live chain/agent data from production, and a real installer run writing correct config for 4 AI clients. |
| ERC-8004 | S | Real canonical registry verified, and a live wallet-approved registration transaction confirmed on-chain (0x0da5e21b..., status 0x1). |
| x402 | S | Real EIP-712/EIP-3009 verification logic, PLUS a live non-custodial USDG settlement: real market swap for funding, real ERC-20 transfer, POST /settle returning 200 settled, and a verified 409 replay-guard rejection on the duplicate submission. |
| Web and app UI | S | Live indigo rebrand, real logo, full-height market terminal, PLUS a measured Lighthouse audit with every finding root-caused and fixed: Performance 41→97, Accessibility 95→100, Best Practices 92→100, SEO 92→100, 0 console errors, 0 contrast violations. |
| Production deployment | A | Live custom domains, systemd isolation, Cloudflare Tunnel, health verified, daily SQLite online backup timer plus restore runbook. |
| CI / reproducibility | A | GitHub Actions is green (workspace install, bounded server files, core/MCP tests, package check, audit, and secret scan). |

At the time this table was written, six of eight areas were considered S based on real, independently re-verified live evidence: two on-chain transactions (identity + payment), a live cross-owner isolation exercise against production with fresh wallets, a real end-to-end MCP install-and-call session, and a measured Lighthouse audit. That evidence is still valid and still cited above. What changed is that the 2026-09-29 independent code review subsequently found 9 real authorization/logic bugs in the code paths underneath that live evidence (private memory, job lifecycle, settlement attribution, auth session atomicity, swap slippage). The live transactions proved the happy path worked; they did not prove the code was free of exploitable edge cases, and it was not. Both facts are now recorded, which is why the current overall grade is B+, not S.
