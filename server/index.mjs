import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { isAddress, verifyMessage } from 'viem';
import { openDatabase, cleanupExpired } from './db.mjs';
import { migrateWorkerSchema } from './worker.mjs';
import { createRegistrationPayload, hashRegistrationPayload, registrationURI, buildRegisterCall, IDENTITY_REGISTRY_ADDRESS } from './identity.mjs';
import { createPaymentRequired, createX402Boundary, parsePaymentSignature, NETWORK as X402_NETWORK } from './x402.mjs';
import { createUsdgFacilitator } from './x402-facilitator.mjs';
import { createDirectTransferFacilitator, USDG_ADDRESS as USDG_SETTLEMENT_ADDRESS } from './x402-onchain-verifier.mjs';
import { createRateLimiter, getCorsHeaders, getSecurityHeaders, formatPublicError } from './security.mjs';
import { migrateRagSchema, indexMemory, recall as ragRecall, contextPack } from './rag.mjs';
import { buildAgentCard, buildMcpManifest } from './interoperability.mjs';
import { migrateSwarmSchema, SwarmState, createBoundedContextInput, runSwarm } from './swarm.mjs';
import { createOpenRouterJevAdapterFromEnv } from './jev-openrouter.mjs';
import { runContextWorker } from './swarm-context-worker.mjs';
import { AGENT_TEMPLATE_IDS, starterVaultForTemplate, templateCapabilities } from './agent-templates.mjs';
import { runAgentBrain } from './agent-brain.mjs';
import { createCustodyWallet } from './agent-custody.mjs';
import { createAutomation, dueAutomations, migrateAutomationSchema } from './agent-automations.mjs';
import { startAutomationLoop } from './agent-automation-runner.mjs';
import { quoteSwap, previewSwap, swapStatus } from './rh-swap.mjs';
import { getWorkerReadiness } from './worker-readiness.mjs';

const PORT = Number(process.env.PORT || 8787);
const CHAIN_ID = 4663;
const RPC_URL = process.env.ROBINHOOD_RPC_URL || 'https://rpc.mainnet.chain.robinhood.com';
const REGISTRIES = {
  identity: '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432',
  reputation: '0x8004BAa17C55a88189AE136b182e5fdA19dE9b63',
};
const SESSION_TTL_MS = 60 * 60 * 1000;
const CHALLENGE_TTL_MS = 10 * 60 * 1000;
const db = openDatabase();
migrateWorkerSchema(db);
migrateRagSchema(db);
migrateSwarmSchema(db);
migrateAutomationSchema(db);
const requestLimiter = createRateLimiter({ limit: Number(process.env.RATE_LIMIT_PER_MINUTE || 120), windowMs: 60_000 });
const swarmDecisionAdapter = createOpenRouterJevAdapterFromEnv();

/**
 * Derives the decisionProvider label from what actually answered each step's
 * decisions, not from whether an API key merely exists at boot time. A
 * configured-but-failing/unreachable Jev provider must honestly report
 * 'offline', never fabricate partial Jev involvement.
 */
function actualDecisionProvider(steps) {
  const providers = new Set();
  for (const step of steps) {
    const gateProvider = step?.decision_provider ?? step?.decisionProvider ?? step?.gate?.provider;
    if (typeof gateProvider === 'string') providers.add(gateProvider);
  }
  if (providers.size === 0) return 'offline';
  if (providers.has('openrouter-jev')) return providers.size === 1 ? 'openrouter-jev' : 'openrouter-jev-partial-offline-fallback';
  return 'offline';
}
const usdgFacilitator = createUsdgFacilitator();
const x402OnchainVerifier = createDirectTransferFacilitator();
const x402Boundary = createX402Boundary({
  verify: (parsedPayment, requirement) => usdgFacilitator.verify(parsedPayment.payload.authorization, requirement),
});
const cleanupTimer = setInterval(() => cleanupExpired(db), 5 * 60_000);
cleanupTimer.unref?.();

const json = (res, status, body) => {
  const origin = res.__requestOrigin || '';
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    ...getCorsHeaders(origin),
    ...getSecurityHeaders(),
    'access-control-allow-headers': 'content-type, authorization',
    'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(body));
};

const readBody = async (req) => {
  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    // Reject before buffering further: an attacker streaming a huge chunked
    // body must not be able to force unbounded memory allocation just because
    // the 256KB ceiling was only checked after the whole stream finished.
    if (length > 256_000) throw new Error('request body too large');
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
};

const now = () => Date.now();
const hash = (value) => createHash('sha256').update(value).digest('hex');
const normalizeWallet = (value) => (typeof value === 'string' && isAddress(value) ? value.toLowerCase() : null);
const cleanText = (value, max) => (typeof value === 'string' && value.trim() && value.length <= max ? value.trim() : null);
const strictObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const jsonValue = (value, maxBytes = 64_000) => {
  if (!strictObject(value)) return null;
  const encoded = JSON.stringify(value);
  return encoded.length <= maxBytes ? encoded : null;
};
const atomicPrice = (value) => (typeof value === 'string' && /^[1-9][0-9]*$/.test(value) ? value : null);
const offeringResponse = (row) => ({
  id: row.id, agentId: row.agent_id, owner: row.owner_wallet, name: row.name,
  description: row.description, priceAtomic: row.price_atomic, asset: row.asset,
  network: row.network, requirements: JSON.parse(row.requirements_json),
  deliverables: JSON.parse(row.deliverables_json), status: row.status,
  createdAt: row.created_at, updatedAt: row.updated_at,
});
const jobResponse = (row) => ({
  id: row.id, offeringId: row.offering_id, buyer: row.buyer_wallet, seller: row.seller_wallet,
  requirements: JSON.parse(row.requirements_json), status: row.status,
  payment: JSON.parse(row.payment_json),
  deliverable: row.deliverable_json ? JSON.parse(row.deliverable_json) : null,
  createdAt: row.created_at, updatedAt: row.updated_at,
});
function audit(actor, entityType, entityId, eventType, payload = {}) {
  db.prepare('INSERT INTO audit_events (id, actor_wallet, entity_type, entity_id, event_type, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(randomUUID(), actor, entityType, entityId, eventType, JSON.stringify(payload), new Date().toISOString());
}

function authMessage(wallet, nonce, expiresAt) {
  return `Coragentic login\n\nWallet: ${wallet}\nChain: Robinhood Chain (4663)\nNonce: ${nonce}\nExpires: ${new Date(expiresAt).toISOString()}\n\nThis request will not cost any gas.`;
}

function sessionWallet(req) {
  const value = req.headers.authorization?.replace(/^Bearer\s+/i, '');
  if (!value) return null;
  const row = db.prepare('SELECT wallet, expires_at FROM sessions WHERE token_hash = ?').get(hash(value));
  if (!row || row.expires_at < now()) return null;
  return row.wallet;
}

async function networkStatus() {
  const response = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }),
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`RPC returned ${response.status}`);
  const body = await response.json();
  if (body.error) throw new Error(body.error.message || 'RPC error');
  return { rpc: 'online', chainId: CHAIN_ID, blockNumber: Number.parseInt(body.result, 16), rpcUrl: RPC_URL, registries: REGISTRIES };
}

function agentResponse(row) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    image: row.image,
    owner: row.owner_wallet,
    status: row.status,
    services: JSON.parse(row.services_json),
    capabilities: JSON.parse(row.capabilities_json),
    supportedTrust: JSON.parse(row.supported_trust_json),
    x402Support: Boolean(row.x402_support),
    network: { namespace: 'eip155', chainId: CHAIN_ID },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function handle(req, res) {
  res.__requestOrigin = req.headers.origin || '';
  const identity = { ip: req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || 'unknown', wallet: req.headers.authorization || '' };
  const limited = requestLimiter.check(identity);
  if (!limited.allowed) {
    res.setHeader('retry-after', String(limited.retryAfterSeconds));
    return json(res, 429, { ok: false, error: 'rate_limited', retryAfterSeconds: limited.retryAfterSeconds });
  }
  if (req.method === 'OPTIONS') return json(res, 204, null);
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const parts = url.pathname.split('/').filter(Boolean);

  if (req.method === 'GET' && url.pathname === '/.well-known/agent.json') {
    const row = db.prepare("SELECT * FROM agents WHERE status != 'archived' ORDER BY created_at ASC LIMIT 1").get();
    return json(res, 200, buildAgentCard(row || { id: 'coragentic-network', name: 'Coragentic Network', description: 'Agent operating network on Robinhood Chain.' }, { baseUrl: `${url.protocol}//${url.host}` }));
  }
  if (req.method === 'GET' && (url.pathname === '/mcp/manifest.json' || url.pathname === '/.well-known/mcp.json')) {
    return json(res, 200, buildMcpManifest({ baseUrl: `${url.protocol}//${url.host}` }));
  }
  if (req.method === 'GET' && parts[0] === 'a2a' && parts[1] === 'agents' && parts[2]) {
    const row = db.prepare('SELECT * FROM agents WHERE id = ?').get(parts[2]);
    if (!row) return json(res, 404, { ok: false, error: 'agent_not_found' });
    return json(res, 200, buildAgentCard(row, { baseUrl: `${url.protocol}//${url.host}` }));
  }
  if (req.method === 'GET' && url.pathname === '/health') {
    return json(res, 200, { ok: true, service: 'coragentic-api', version: '1.0.0', chainId: CHAIN_ID });
  }
  if (req.method === 'GET' && url.pathname === '/health/worker') {
    // Read a worker heartbeat from DB rather than importing executor in the API process.
    // Worker writes its own heartbeat; API only reads the record.
    const heartbeat = db.prepare('SELECT ready, reason, updated_at FROM worker_heartbeat LIMIT 1').get() ?? null;
    const configured = typeof process.env.CORAGENTIC_JOB_EXECUTOR === 'string' && Boolean(process.env.CORAGENTIC_JOB_EXECUTOR.trim());
    const heartbeatReady = heartbeat?.ready === 1;
    const stale = heartbeat && (Date.now() - new Date(heartbeat.updated_at).getTime() > 60_000);
    const finalReady = heartbeatReady && !stale;
    // A genuinely ready heartbeat carries reason=null (see worker-entry.mjs's
    // writeHeartbeat(true)); only fall back to a placeholder explanation when
    // the worker is NOT actually ready, so ready:true never ships alongside a
    // contradictory "not running" string.
    const reason = stale ? 'heartbeat_stale' : finalReady ? null : (heartbeat?.reason ?? (configured ? 'executor_configured_worker_not_running' : 'executor_not_configured'));
    const data = { configured, ready: finalReady, reason };
    return json(res, data.ready ? 200 : 503, { ok: data.ready, worker: data });
  }
  if (req.method === 'GET' && url.pathname === '/v1/network') {
    try { return json(res, 200, { ok: true, data: await networkStatus() }); }
    catch (error) { return json(res, 503, { ok: false, error: 'rpc_unavailable', message: error.message }); }
  }
  if (req.method === 'GET' && url.pathname === '/v1/market/quote') {
    const token = url.searchParams.get('token');
    const amount = url.searchParams.get('amount');
    const amountDecimals = url.searchParams.has('amountDecimals') ? Number(url.searchParams.get('amountDecimals')) : undefined;
    const slippageBps = url.searchParams.has('slippageBps') ? Number(url.searchParams.get('slippageBps')) : undefined;
    return json(res, 200, { ok: true, data: await quoteSwap({ token, amount, amountDecimals, slippageBps }) });
  }
  if (req.method === 'GET' && url.pathname === '/v1/market/swap-preview') {
    const token = url.searchParams.get('token');
    const amount = url.searchParams.get('amount');
    const wallet = url.searchParams.get('wallet');
    const amountDecimals = url.searchParams.has('amountDecimals') ? Number(url.searchParams.get('amountDecimals')) : undefined;
    const slippageBps = url.searchParams.has('slippageBps') ? Number(url.searchParams.get('slippageBps')) : undefined;
    return json(res, 200, { ok: true, data: await previewSwap({ token, amount, amountDecimals, slippageBps }, { wallet }) });
  }
  if (req.method === 'GET' && url.pathname === '/v1/market/swap-status') {
    return json(res, 200, { ok: true, data: await swapStatus(url.searchParams.get('txHash')) });
  }
  if (req.method === 'GET' && url.pathname === '/v1/swarm/status') {
    const wallet = sessionWallet(req);
    if (!wallet) return json(res, 401, { ok: false, error: 'wallet_session_required' });
    // DISTINCT matters: a real run accumulates multiple audit events for the
    // same actor wallet (created, step updates, final decision), and this
    // JOIN previously returned one row per matching audit event -- a single
    // run with 4 events rendered as 4 duplicate cards in the Swarms UI.
    const rows = db.prepare(
      "SELECT DISTINCT sr.id, sr.status, sr.human_escalation, sr.created_at, sr.updated_at FROM swarm_runs sr JOIN audit_events ae ON ae.entity_type = 'swarm' AND ae.entity_id = sr.id AND ae.actor_wallet = ? ORDER BY sr.updated_at DESC LIMIT 50"
    ).all(wallet);
    return json(res, 200, { ok: true, data: rows });
  }
  if (req.method === 'POST' && url.pathname === '/v1/swarm/runs') {
    const wallet = sessionWallet(req);
    if (!wallet) return json(res, 401, { ok: false, error: 'wallet_session_required' });
    const body = await readBody(req);
    const goal = cleanText(body.goal, 2_000);
    const contextRequest = strictObject(body.context) && Object.keys(body.context).every((key) => ['agentId', 'query'].includes(key)) ? body.context : null;
    // Validate query early before any DB access or persistence
    if (!contextRequest || typeof contextRequest.query !== 'string' || !contextRequest.query.trim() || contextRequest.query.trim().length > 160) {
      return json(res, 400, { ok: false, error: 'invalid_swarm_run', detail: 'context.query must be a non-empty string of at most 160 characters' });
    }
    const workers = Array.isArray(body.workers) ? body.workers : [];
    const validWorkers = workers.length > 0 && workers.length <= 8 && workers.every((worker) => strictObject(worker)
      && Object.keys(worker).every((key) => ['id', 'capabilities'].includes(key))
      && cleanText(worker.id, 80)
      && Array.isArray(worker.capabilities) && worker.capabilities.length <= 20
      && worker.capabilities.every((capability) => cleanText(capability, 80)));
    if (!goal || !contextRequest || !validWorkers || new Set(workers.map((worker) => worker.id)).size !== workers.length) {
      return json(res, 400, { ok: false, error: 'invalid_swarm_run' });
    }
    const agent = db.prepare('SELECT owner_wallet FROM agents WHERE id = ?').get(contextRequest.agentId);
    if (!agent) return json(res, 404, { ok: false, error: 'agent_not_found' });
    if (agent.owner_wallet !== wallet) return json(res, 403, { ok: false, error: 'agent_owner_required' });
    const context = createBoundedContextInput(db, contextRequest, { ownerWallet: wallet, budget: 4_000 });
    const state = new SwarmState(db, { actor: wallet });
    const runId = state.createRun({ goal, sharedEvidence: { context: context.metadata } });
    const steps = workers.map((worker) => ({
      key: `worker:${worker.id}`,
      input: { worker: { id: worker.id, capabilities: worker.capabilities }, context: context.metadata },
      privateContext: context,
    }));
    await runSwarm(state, runId, steps, async (step) => {
      // The built-in "context-worker" now actually answers the caller's
      // query grounded in their own retrieved private context (see
      // swarm-context-worker.mjs) instead of declaring capabilities without
      // doing anything -- the jev judge previously had nothing real to
      // score, so runs were rejected almost regardless of context quality.
      // A worker whose capabilities don't include "context" keeps the
      // original declared-not-executed shape (nothing to ground an answer
      // in for a capability this route doesn't implement).
      if (step.input.worker.capabilities.includes('context')) {
        const result = await runContextWorker(step.privateContext, {});
        return { workerId: step.input.worker.id, capabilities: step.input.worker.capabilities, ...result, contextEvidenceCount: step.privateContext.evidence.length };
      }
      return {
        workerId: step.input.worker.id,
        capabilities: step.input.worker.capabilities,
        status: 'declared_not_executed',
        contextEvidenceCount: step.privateContext.evidence.length,
      };
    }, { concurrency: 4, adapter: swarmDecisionAdapter });
    const finalSteps = state.listSteps(runId);
    const decisionProvider = actualDecisionProvider(finalSteps);
    state.updateRun(runId, { sharedEvidence: { ...state.getRun(runId).sharedEvidence, decisionProvider } });
    return json(res, 201, { ok: true, data: { ...state.getRun(runId), steps: finalSteps, decisionProvider } });
  }
  if (req.method === 'GET' && parts[0] === 'v1' && parts[1] === 'swarm' && parts[2]) {
    const wallet = sessionWallet(req);
    if (!wallet) return json(res, 401, { ok: false, error: 'wallet_session_required' });
    const state = new SwarmState(db);
    const run = state.getRun(parts[2]);
    if (!run) return json(res, 404, { ok: false, error: 'swarm_not_found' });
    const context = run.sharedEvidence?.context;
    if (!context?.agentId) return json(res, 403, { ok: false, error: 'swarm_owner_required' });
    const agent = db.prepare('SELECT owner_wallet FROM agents WHERE id = ?').get(context.agentId);
    if (!agent || agent.owner_wallet !== wallet) return json(res, 403, { ok: false, error: 'swarm_owner_required' });
    return json(res, 200, { ok: true, data: { ...run, steps: state.listSteps(parts[2]), decisionProvider: run.sharedEvidence.decisionProvider } });
  }
  if (req.method === 'POST' && url.pathname === '/v1/auth/challenge') {
    const body = await readBody(req);
    const wallet = normalizeWallet(body.wallet);
    if (!wallet) return json(res, 400, { ok: false, error: 'invalid_wallet' });
    const nonce = randomUUID();
    const expiresAt = now() + CHALLENGE_TTL_MS;
    const message = authMessage(wallet, nonce, expiresAt);
    db.prepare('INSERT INTO auth_challenges (nonce, wallet, message, expires_at) VALUES (?, ?, ?, ?)').run(nonce, wallet, message, expiresAt);
    return json(res, 200, { ok: true, data: { nonce, message, expiresAt } });
  }
  if (req.method === 'GET' && url.pathname === '/v1/session') {
    // Cheap whoami so the frontend can verify a STORED bearer token is still
    // accepted on mount, without relying on a public route (GET /v1/agents
    // returns 200 regardless of auth and can never surface a stale token).
    const wallet = sessionWallet(req);
    if (!wallet) return json(res, 401, { ok: false, error: 'wallet_session_required' });
    return json(res, 200, { ok: true, data: { wallet } });
  }
  if (req.method === 'POST' && url.pathname === '/v1/auth/verify') {
    const body = await readBody(req);
    const wallet = normalizeWallet(body.wallet);
    const signature = cleanText(body.signature, 256);
    const nonce = cleanText(body.nonce, 80);
    if (!wallet || !signature || !nonce) return json(res, 400, { ok: false, error: 'wallet_signature_nonce_required' });
    const challenge = db.prepare('SELECT * FROM auth_challenges WHERE nonce = ? AND wallet = ?').get(nonce, wallet);
    if (!challenge || challenge.used_at || challenge.expires_at < now()) return json(res, 401, { ok: false, error: 'challenge_invalid_or_expired' });
    // Atomically claim the challenge BEFORE the async signature check: verifyMessage
    // yields the event loop, so two concurrent /verify calls for the same nonce can
    // both pass the SELECT-based check above before either writes used_at. Guarding
    // the UPDATE on used_at IS NULL turns that into a clean single winner -- the
    // loser's claim affects 0 rows and is rejected, instead of both minting a session.
    const claim = db.prepare('UPDATE auth_challenges SET used_at = ? WHERE nonce = ? AND wallet = ? AND used_at IS NULL AND expires_at >= ?').run(now(), nonce, wallet, now());
    if (claim.changes === 0) return json(res, 401, { ok: false, error: 'challenge_invalid_or_expired' });
    let valid = false;
    try { valid = await verifyMessage({ address: wallet, message: challenge.message, signature }); } catch { valid = false; }
    if (!valid) return json(res, 401, { ok: false, error: 'signature_invalid' });
    const token = randomBytes(32).toString('hex');
    db.prepare('INSERT INTO sessions (token_hash, wallet, expires_at) VALUES (?, ?, ?)').run(hash(token), wallet, now() + SESSION_TTL_MS);
    return json(res, 200, { ok: true, data: { token, wallet, expiresAt: now() + SESSION_TTL_MS } });
  }
  if (req.method === 'GET' && url.pathname === '/v1/agents') {
    const rows = db.prepare("SELECT * FROM agents WHERE status != 'archived' ORDER BY created_at DESC").all();
    return json(res, 200, { ok: true, data: rows.map(agentResponse), total: rows.length });
  }
  if (req.method === 'GET' && parts[0] === 'v1' && parts[1] === 'agents' && parts[2] && parts[3] === 'identity') {
    const row = db.prepare('SELECT * FROM agents WHERE id = ?').get(parts[2]);
    if (!row) return json(res, 404, { ok: false, error: 'agent_not_found' });
    const payload = createRegistrationPayload({
      type: 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1',
      name: row.name,
      description: row.description,
      image: row.image,
      services: JSON.parse(row.services_json),
      capabilities: JSON.parse(row.capabilities_json),
      supportedTrust: JSON.parse(row.supported_trust_json),
      x402Support: Boolean(row.x402_support),
      network: { namespace: 'eip155', chainId: CHAIN_ID },
    });
    return json(res, 200, { ok: true, data: { payload, hash: hashRegistrationPayload(payload), uri: registrationURI(payload), onchain: false, registry: REGISTRIES.identity, chainId: CHAIN_ID } });
  }
  if (req.method === 'GET' && parts[0] === 'v1' && parts[1] === 'agents' && parts[2] && parts[3] === 'registration-call') {
    const wallet = sessionWallet(req);
    if (!wallet) return json(res, 401, { ok: false, error: 'wallet_session_required' });
    const row = db.prepare('SELECT * FROM agents WHERE id = ?').get(parts[2]);
    if (!row) return json(res, 404, { ok: false, error: 'agent_not_found' });
    if (row.owner_wallet !== wallet) return json(res, 403, { ok: false, error: 'agent_owner_required' });
    const payload = createRegistrationPayload({
      type: 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1',
      name: row.name,
      description: row.description,
      image: row.image,
      services: JSON.parse(row.services_json),
      capabilities: JSON.parse(row.capabilities_json),
      supportedTrust: JSON.parse(row.supported_trust_json),
      x402Support: Boolean(row.x402_support),
      network: { namespace: 'eip155', chainId: CHAIN_ID },
    });
    const call = buildRegisterCall({ registryAddress: IDENTITY_REGISTRY_ADDRESS, payload });
    if (!call.supported) return json(res, 503, { ok: false, error: 'registration_call_unsupported', reason: call.reason });
    return json(res, 200, {
      ok: true,
      data: {
        chainId: CHAIN_ID,
        registry: IDENTITY_REGISTRY_ADDRESS,
        to: call.to,
        data: call.data,
        functionName: call.functionName,
        unsigned: true,
        custody: 'external_wallet_required',
        warning: 'This is unsigned calldata for the ERC-8004 IdentityRegistry.register(string) call. Review it, then sign and broadcast from an external wallet. Coragentic never holds a private key and does not submit this transaction on your behalf.',
      },
    });
  }
  if (req.method === 'GET' && parts[0] === 'v1' && parts[1] === 'agents' && parts[2] && parts[3] === 'offerings') {
    const agent = db.prepare('SELECT id FROM agents WHERE id = ?').get(parts[2]);
    if (!agent) return json(res, 404, { ok: false, error: 'agent_not_found' });
    const rows = db.prepare("SELECT * FROM offerings WHERE agent_id = ? AND status = 'active' ORDER BY created_at DESC").all(parts[2]);
    return json(res, 200, { ok: true, data: rows.map(offeringResponse), total: rows.length });
  }
  if (req.method === 'POST' && parts[0] === 'v1' && parts[1] === 'agents' && parts[2] && parts[3] === 'offerings') {
    const wallet = sessionWallet(req);
    if (!wallet) return json(res, 401, { ok: false, error: 'wallet_session_required' });
    const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(parts[2]);
    if (!agent) return json(res, 404, { ok: false, error: 'agent_not_found' });
    if (agent.owner_wallet !== wallet) return json(res, 403, { ok: false, error: 'agent_owner_required' });
    const body = await readBody(req);
    const name = cleanText(body.name, 120);
    const description = cleanText(body.description, 4_000);
    const priceAtomic = atomicPrice(body.priceAtomic);
    const asset = cleanText(body.asset, 80);
    const network = cleanText(body.network, 120);
    const requirements = jsonValue(body.requirements ?? {});
    const deliverables = jsonValue(body.deliverables ?? {});
    if (!name || !description || !priceAtomic || !asset || !network || !requirements || !deliverables) {
      return json(res, 400, { ok: false, error: 'invalid_offering' });
    }
    // Only USDG is actually accepted end to end: verify-payment (EIP-3009) and
    // settle (direct transfer) both hardcode USDG. Advertising any other asset
    // here would publish an x402 requirement that can never be honored.
    if (asset.toLowerCase() !== USDG_SETTLEMENT_ADDRESS.toLowerCase()) {
      return json(res, 400, { ok: false, error: 'unsupported_asset' });
    }
    const id = randomUUID();
    const timestamp = new Date().toISOString();
    db.prepare('INSERT INTO offerings (id, agent_id, owner_wallet, name, description, price_atomic, asset, network, requirements_json, deliverables_json, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, agent.id, wallet, name, description, priceAtomic, asset, network, requirements, deliverables, 'active', timestamp, timestamp);
    audit(wallet, 'offering', id, 'offering_created', { agentId: agent.id });
    return json(res, 201, { ok: true, data: offeringResponse(db.prepare('SELECT * FROM offerings WHERE id = ?').get(id)) });
  }
  if (req.method === 'GET' && parts[0] === 'v1' && parts[1] === 'offerings' && parts[2] && parts[3] === 'payment-required') {
    const offering = db.prepare("SELECT * FROM offerings WHERE id = ? AND status = 'active'").get(parts[2]);
    if (!offering) return json(res, 404, { ok: false, error: 'offering_not_found' });
    const requirement = createPaymentRequired({
      amount: offering.price_atomic,
      asset: offering.asset,
      payTo: offering.owner_wallet,
      resource: `/v1/offerings/${offering.id}/jobs`,
      description: offering.description,
    });
    return json(res, 200, { ok: true, data: { ...requirement, network: X402_NETWORK, settlement: 'verify_available_settlement_requires_relayer' } });
  }
  if (req.method === 'POST' && parts[0] === 'v1' && parts[1] === 'offerings' && parts[2] && parts[3] === 'verify-payment') {
    const offering = db.prepare("SELECT * FROM offerings WHERE id = ? AND status = 'active'").get(parts[2]);
    if (!offering) return json(res, 404, { ok: false, error: 'offering_not_found' });
    const body = await readBody(req);
    const signature = typeof body.signature === 'string' ? body.signature : null;
    if (!signature) return json(res, 400, { ok: false, error: 'signature_required' });
    const requirement = createPaymentRequired({
      amount: offering.price_atomic,
      asset: offering.asset,
      payTo: offering.owner_wallet,
      resource: `/v1/offerings/${offering.id}/jobs`,
      description: offering.description,
    });
    const parsed = parsePaymentSignature(signature);
    if (!parsed.ok) return json(res, 400, { ok: false, error: parsed.error });
    const result = await x402Boundary.verifyPayment(signature, requirement);
    const status = result.status === 'verified' ? 200 : result.status === 'unavailable' ? 503 : 402;
    return json(res, status, { ok: result.status === 'verified', data: result });
  }
  if (req.method === 'POST' && parts[0] === 'v1' && parts[1] === 'offerings' && parts[2] && parts[3] === 'settle') {
    const offering = db.prepare("SELECT * FROM offerings WHERE id = ? AND status = 'active'").get(parts[2]);
    if (!offering) return json(res, 404, { ok: false, error: 'offering_not_found' });
    const body = await readBody(req);
    const txHash = typeof body.txHash === 'string' ? body.txHash : null;
    if (!txHash) return json(res, 400, { ok: false, error: 'tx_hash_required' });
    // A settlement must be bound to a specific job, not just "some job at this
    // offering's price". Without this, one observed on-chain transfer could be
    // claimed as payment for any job sharing the same offering/price/seller.
    const jobId = typeof body.jobId === 'string' ? body.jobId : null;
    if (!jobId) return json(res, 400, { ok: false, error: 'job_id_required' });
    const job = db.prepare('SELECT * FROM jobs WHERE id = ? AND offering_id = ?').get(jobId, offering.id);
    if (!job) return json(res, 404, { ok: false, error: 'job_not_found' });
    const requirement = createPaymentRequired({
      amount: offering.price_atomic,
      asset: offering.asset,
      payTo: offering.owner_wallet,
      resource: `/v1/offerings/${offering.id}/jobs`,
      description: offering.description,
    });
    const result = await x402OnchainVerifier.verifyTransaction(txHash, requirement);
    if (result.status !== 'verified') {
      const status = result.status === 'unavailable' ? 503 : 402;
      return json(res, status, { ok: false, data: result });
    }
    // The verified payer must actually be this job's buyer -- otherwise a
    // seller's own transfer (or a third party's) could settle someone else's
    // job. Combined with the job_id uniqueness index below, this closes the
    // order-attribution gap: one transfer settles exactly one job, for its
    // actual buyer, and only once.
    if (result.payer.toLowerCase() !== job.buyer_wallet.toLowerCase()) {
      return json(res, 403, { ok: false, error: 'payer_does_not_match_job_buyer' });
    }
    // Atomic replay guard: tx_hash is PRIMARY KEY, and job_id has a unique
    // index, so a concurrent duplicate settle (of the same tx OR against a
    // second job) fails at the database layer, not via app-level check-then-act.
    try {
      db.prepare('INSERT INTO x402_settlements (tx_hash, offering_id, payer_wallet, amount_atomic, created_at, job_id) VALUES (?, ?, ?, ?, ?, ?)')
        .run(txHash, offering.id, result.payer, result.amount, new Date().toISOString(), jobId);
    } catch {
      return json(res, 409, { ok: false, error: 'transaction_already_settled' });
    }
    db.prepare('UPDATE jobs SET payment_json = ? WHERE id = ?').run(JSON.stringify({ status: 'settled', txHash, amount: result.amount }), jobId);
    audit(result.payer, 'offering', offering.id, 'x402_settled', { txHash, amount: result.amount, jobId });
    return json(res, 200, { ok: true, data: { status: 'settled', txHash, payer: result.payer, amount: result.amount, offeringId: offering.id, jobId } });
  }
  if (req.method === 'POST' && parts[0] === 'v1' && parts[1] === 'offerings' && parts[2] && parts[3] === 'jobs') {
    const wallet = sessionWallet(req);
    if (!wallet) return json(res, 401, { ok: false, error: 'wallet_session_required' });
    const offering = db.prepare("SELECT * FROM offerings WHERE id = ? AND status = 'active'").get(parts[2]);
    if (!offering) return json(res, 404, { ok: false, error: 'offering_not_found' });
    const body = await readBody(req);
    const requirements = jsonValue(body.requirements ?? {});
    if (!requirements) return json(res, 400, { ok: false, error: 'invalid_requirements' });
    const id = randomUUID();
    const timestamp = new Date().toISOString();
    const payment = JSON.stringify({ status: 'unpaid', network: 'eip155:4663' });
    db.prepare('INSERT INTO jobs (id, offering_id, buyer_wallet, seller_wallet, requirements_json, status, payment_json, deliverable_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, offering.id, wallet, offering.owner_wallet, requirements, 'requested', payment, null, timestamp, timestamp);
    audit(wallet, 'job', id, 'job_requested', { offeringId: offering.id, paymentStatus: 'unpaid' });
    return json(res, 201, { ok: true, data: jobResponse(db.prepare('SELECT * FROM jobs WHERE id = ?').get(id)) });
  }
  if (req.method === 'GET' && parts[0] === 'v1' && parts[1] === 'agents' && parts[2] && parts[3] === 'jobs') {
    const wallet = sessionWallet(req);
    if (!wallet) return json(res, 401, { ok: false, error: 'wallet_session_required' });
    const agent = db.prepare('SELECT owner_wallet FROM agents WHERE id = ?').get(parts[2]);
    if (!agent) return json(res, 404, { ok: false, error: 'agent_not_found' });
    if (agent.owner_wallet !== wallet) return json(res, 403, { ok: false, error: 'agent_owner_required' });
    const rows = db.prepare('SELECT j.* FROM jobs j JOIN offerings o ON o.id = j.offering_id WHERE o.agent_id = ? ORDER BY j.updated_at DESC LIMIT 100').all(parts[2]);
    return json(res, 200, { ok: true, data: rows.map(jobResponse) });
  }
  if (req.method === 'GET' && parts[0] === 'v1' && parts[1] === 'jobs' && parts[2]) {
    const wallet = sessionWallet(req);
    if (!wallet) return json(res, 401, { ok: false, error: 'wallet_session_required' });
    const row = db.prepare('SELECT * FROM jobs WHERE id = ?').get(parts[2]);
    if (!row) return json(res, 404, { ok: false, error: 'job_not_found' });
    if (row.buyer_wallet !== wallet && row.seller_wallet !== wallet) return json(res, 403, { ok: false, error: 'job_participant_required' });
    return json(res, 200, { ok: true, data: jobResponse(row) });
  }
  if (req.method === 'POST' && parts[0] === 'v1' && parts[1] === 'jobs' && parts[2] && parts[3] === 'status') {
    const wallet = sessionWallet(req);
    if (!wallet) return json(res, 401, { ok: false, error: 'wallet_session_required' });
    const row = db.prepare('SELECT * FROM jobs WHERE id = ?').get(parts[2]);
    if (!row) return json(res, 404, { ok: false, error: 'job_not_found' });
    const body = await readBody(req);
    const next = cleanText(body.status, 40);
    const transitions = {
      requested: { accepted: row.seller_wallet, cancelled: row.buyer_wallet },
      accepted: { submitted: row.seller_wallet, cancelled: row.seller_wallet },
      submitted: { completed: row.buyer_wallet },
    };
    if (!next || transitions[row.status]?.[next] !== wallet) return json(res, 409, { ok: false, error: 'invalid_status_transition' });
    // A job cannot proceed to worker execution until its payment has actually
    // settled -- otherwise the worker can deliver paid work for free, since
    // execution was previously gated only on the requested->accepted actor
    // check and never checked payment_json at all.
    if (next === 'accepted') {
      const paymentStatus = JSON.parse(row.payment_json).status;
      if (paymentStatus !== 'settled') return json(res, 409, { ok: false, error: 'payment_not_settled' });
    }
    let deliverable = row.deliverable_json;
    if (next === 'submitted') {
      deliverable = jsonValue(body.deliverable);
      if (!deliverable) return json(res, 400, { ok: false, error: 'deliverable_required' });
    } else if (body.deliverable !== undefined) {
      return json(res, 400, { ok: false, error: 'deliverable_not_allowed' });
    }
    const timestamp = new Date().toISOString();
    // Compare-and-swap on the prior status: readBody() above yields the event
    // loop, so a concurrent request can read the same stale row before this
    // write lands. Guarding the UPDATE on status = row.status turns a lost
    // update into a clean 409 for whichever request loses the race.
    const result = db.prepare('UPDATE jobs SET status = ?, deliverable_json = ?, updated_at = ? WHERE id = ? AND status = ?').run(next, deliverable, timestamp, row.id, row.status);
    if (result.changes === 0) return json(res, 409, { ok: false, error: 'invalid_status_transition' });
    audit(wallet, 'job', row.id, `job_${next}`, { from: row.status, to: next });
    return json(res, 200, { ok: true, data: jobResponse(db.prepare('SELECT * FROM jobs WHERE id = ?').get(row.id)) });
  }
  if (req.method === 'GET' && parts[0] === 'v1' && parts[1] === 'agents' && parts[2] && parts[3] === 'memory') {
    const wallet = sessionWallet(req);
    if (!wallet) return json(res, 401, { ok: false, error: 'wallet_session_required' });
    const agent = db.prepare('SELECT owner_wallet FROM agents WHERE id = ?').get(parts[2]);
    if (!agent) return json(res, 404, { ok: false, error: 'agent_not_found' });
    if (agent.owner_wallet !== wallet) return json(res, 403, { ok: false, error: 'agent_owner_required' });
    const q = cleanText(url.searchParams.get('q') || '', 160);
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit') || 50), 1), 100);
    const rows = q
      ? ragRecall(db, q, { agentId: parts[2], limit })
      : db.prepare('SELECT * FROM agent_memory WHERE agent_id = ? ORDER BY updated_at DESC LIMIT ?').all(parts[2], limit).map((row) => ({ id: row.id, key: row.memory_key, content: row.content, tags: JSON.parse(row.tags_json), createdAt: row.created_at, updatedAt: row.updated_at }));
    return json(res, 200, { ok: true, data: rows.map((row) => ({ id: row.id, key: row.key ?? row.memory_key, content: row.content, tags: row.tags ?? JSON.parse(row.tags_json || '[]'), createdAt: row.createdAt ?? row.created_at, updatedAt: row.updatedAt ?? row.updated_at, score: row.score ?? null })), total: rows.length });
  }
  if (req.method === 'POST' && parts[0] === 'v1' && parts[1] === 'agents' && parts[2] && parts[3] === 'memory') {
    const wallet = sessionWallet(req);
    if (!wallet) return json(res, 401, { ok: false, error: 'wallet_session_required' });
    const agent = db.prepare('SELECT owner_wallet FROM agents WHERE id = ?').get(parts[2]);
    if (!agent) return json(res, 404, { ok: false, error: 'agent_not_found' });
    if (agent.owner_wallet !== wallet) return json(res, 403, { ok: false, error: 'agent_owner_required' });
    const body = await readBody(req);
    const key = cleanText(body.key, 160);
    const content = cleanText(body.content, 8_000);
    const tags = Array.isArray(body.tags) ? body.tags.slice(0, 20).filter((tag) => typeof tag === 'string' && tag.length <= 80) : [];
    if (!key || !content) return json(res, 400, { ok: false, error: 'memory_key_and_content_required' });
    const timestamp = new Date().toISOString();
    const id = randomUUID();
    db.prepare(`INSERT INTO agent_memory (id, agent_id, owner_wallet, memory_key, content, tags_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(agent_id, memory_key) DO UPDATE SET content = excluded.content, tags_json = excluded.tags_json, updated_at = excluded.updated_at`).run(id, parts[2], wallet, key, content, JSON.stringify(tags), timestamp, timestamp);
    const row = db.prepare('SELECT * FROM agent_memory WHERE agent_id = ? AND memory_key = ?').get(parts[2], key);
    indexMemory(db, row);
    audit(wallet, 'agent_memory', row.id, 'memory_retained', { agentId: parts[2], key });
    return json(res, 200, { ok: true, data: { id: row.id, key: row.memory_key, content: row.content, tags: JSON.parse(row.tags_json), createdAt: row.created_at, updatedAt: row.updated_at } });
  }
  if (req.method === 'GET' && parts[0] === 'v1' && parts[1] === 'agents' && parts[2] && parts[3] === 'runs') {
    const wallet = sessionWallet(req);
    if (!wallet) return json(res, 401, { ok: false, error: 'wallet_session_required' });
    const agent = db.prepare('SELECT owner_wallet FROM agents WHERE id = ?').get(parts[2]);
    if (!agent) return json(res, 404, { ok: false, error: 'agent_not_found' });
    if (agent.owner_wallet !== wallet) return json(res, 403, { ok: false, error: 'agent_owner_required' });
    const rows = db.prepare('SELECT * FROM agent_runs WHERE agent_id = ? AND owner_wallet = ? ORDER BY created_at DESC LIMIT 50').all(parts[2], wallet);
    return json(res, 200, { ok: true, data: rows.map((row) => ({ id: row.id, kind: row.kind, request: row.request, result: JSON.parse(row.result_json), createdAt: row.created_at })) });
  }
  if (req.method === 'POST' && parts[0] === 'v1' && parts[1] === 'agents' && parts[2] && parts[3] === 'think') {
    const wallet = sessionWallet(req);
    if (!wallet) return json(res, 401, { ok: false, error: 'wallet_session_required' });
    const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(parts[2]);
    if (!agent) return json(res, 404, { ok: false, error: 'agent_not_found' });
    if (agent.owner_wallet !== wallet) return json(res, 403, { ok: false, error: 'agent_owner_required' });
    const body = await readBody(req);
    const request = cleanText(body.request, 4_000);
    if (!request) return json(res, 400, { ok: false, error: 'agent_request_required' });
    const pack = contextPack(db, request, 4_000, { agentId: parts[2], ownerWallet: wallet });
    const mission = db.prepare('SELECT content FROM agent_memory WHERE agent_id = ? AND owner_wallet = ? AND memory_key = ?').get(parts[2], wallet, 'mission')?.content ?? agent.description;
    const result = await runAgentBrain({ mission, request, context: pack.text });
    // Model-generated citations are advisory until checked against the exact
    // evidence pack used for this run. Never persist or display fabricated
    // IDs as proof of grounding.
    const allowedEvidenceIds = new Set(pack.evidence.map((item) => item.id));
    result.citedEvidenceIds = result.citedEvidenceIds.filter((id) => allowedEvidenceIds.has(id));
    const timestamp = new Date().toISOString();
    const runId = randomUUID();
    db.prepare('INSERT INTO agent_runs (id, agent_id, owner_wallet, kind, request, result_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(runId, parts[2], wallet, 'brain', request, JSON.stringify({ ...result, evidenceCount: pack.evidence.length }), timestamp);
    audit(wallet, 'agent_run', runId, 'agent_thought', { agentId: parts[2], evidenceCount: pack.evidence.length });
    return json(res, 201, { ok: true, data: { id: runId, kind: 'brain', request, result: { ...result, evidenceCount: pack.evidence.length }, createdAt: timestamp } });
  }
  if (req.method === 'GET' && parts[0] === 'v1' && parts[1] === 'agents' && parts[2] && parts[3] === 'wallet') {
    const wallet = sessionWallet(req);
    if (!wallet) return json(res, 401, { ok: false, error: 'wallet_session_required' });
    const agent = db.prepare('SELECT owner_wallet FROM agents WHERE id = ?').get(parts[2]);
    if (!agent) return json(res, 404, { ok: false, error: 'agent_not_found' });
    if (agent.owner_wallet !== wallet) return json(res, 403, { ok: false, error: 'agent_owner_required' });
    const row = db.prepare('SELECT agent_id, address, policy_json, created_at, updated_at FROM agent_wallets WHERE agent_id = ?').get(parts[2]);
    return json(res, 200, { ok: true, data: row ? { address: row.address, policy: JSON.parse(row.policy_json), createdAt: row.created_at, updatedAt: row.updated_at } : null });
  }
  if (req.method === 'POST' && parts[0] === 'v1' && parts[1] === 'agents' && parts[2] && parts[3] === 'wallet') {
    const wallet = sessionWallet(req);
    if (!wallet) return json(res, 401, { ok: false, error: 'wallet_session_required' });
    const agent = db.prepare('SELECT owner_wallet FROM agents WHERE id = ?').get(parts[2]);
    if (!agent) return json(res, 404, { ok: false, error: 'agent_not_found' });
    if (agent.owner_wallet !== wallet) return json(res, 403, { ok: false, error: 'agent_owner_required' });
    // A custody address is fundable on-chain even before signing exists. Do
    // not expose new addresses until recovery/withdrawal, rotation and backup
    // recovery have passed security review; otherwise users can permanently
    // lock funds. Existing records remain address-only and spend-disabled.
    if (process.env.CORAGENTIC_CUSTODY_WALLETS_ENABLED !== 'true') return json(res, 503, { ok: false, error: 'custody_recovery_not_ready' });
    const existing = db.prepare('SELECT agent_id, address, policy_json, created_at, updated_at FROM agent_wallets WHERE agent_id = ?').get(parts[2]);
    if (existing) return json(res, 200, { ok: true, data: { address: existing.address, policy: JSON.parse(existing.policy_json), createdAt: existing.created_at, updatedAt: existing.updated_at } });
    if (!process.env.CORAGENTIC_CUSTODY_KEY) return json(res, 503, { ok: false, error: 'custody_not_configured' });
    const created = createCustodyWallet(process.env.CORAGENTIC_CUSTODY_KEY);
    const timestamp = new Date().toISOString();
    const policy = { spendEnabled: false, dailyLimitUsd: 0, allowedSkills: [], requireOwnerApproval: true };
    db.prepare('INSERT INTO agent_wallets (agent_id, owner_wallet, address, encrypted_private_key, policy_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(parts[2], wallet, created.address, created.encryptedPrivateKey, JSON.stringify(policy), timestamp, timestamp);
    audit(wallet, 'agent_wallet', parts[2], 'custody_wallet_created', { address: created.address, policy });
    return json(res, 201, { ok: true, data: { address: created.address, policy, createdAt: timestamp, updatedAt: timestamp } });
  }
  if (req.method === 'GET' && parts[0] === 'v1' && parts[1] === 'agents' && parts[2] && parts[3] === 'skills') {
    const wallet = sessionWallet(req);
    if (!wallet) return json(res, 401, { ok: false, error: 'wallet_session_required' });
    const agent = db.prepare('SELECT owner_wallet FROM agents WHERE id = ?').get(parts[2]);
    if (!agent) return json(res, 404, { ok: false, error: 'agent_not_found' });
    if (agent.owner_wallet !== wallet) return json(res, 403, { ok: false, error: 'agent_owner_required' });
    const rows = db.prepare('SELECT skill_id, enabled, config_json, installed_at FROM agent_skills WHERE agent_id = ? ORDER BY installed_at DESC').all(parts[2]);
    return json(res, 200, { ok: true, data: rows.map((row) => ({ id: row.skill_id, enabled: Boolean(row.enabled), config: JSON.parse(row.config_json), installedAt: row.installed_at })) });
  }
  if (req.method === 'POST' && parts[0] === 'v1' && parts[1] === 'agents' && parts[2] && parts[3] === 'skills') {
    const wallet = sessionWallet(req);
    if (!wallet) return json(res, 401, { ok: false, error: 'wallet_session_required' });
    const agent = db.prepare('SELECT owner_wallet FROM agents WHERE id = ?').get(parts[2]);
    if (!agent) return json(res, 404, { ok: false, error: 'agent_not_found' });
    if (agent.owner_wallet !== wallet) return json(res, 403, { ok: false, error: 'agent_owner_required' });
    const body = await readBody(req); const skillId = cleanText(body.skillId, 80);
    const catalog = new Set(['research-brief', 'swarm-analysis', 'report-writer', 'uniswap']);
    if (!catalog.has(skillId)) return json(res, 400, { ok: false, error: 'invalid_agent_skill' });
    const timestamp = new Date().toISOString();
    db.prepare('INSERT INTO agent_skills (agent_id, owner_wallet, skill_id, enabled, config_json, installed_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(agent_id, skill_id) DO UPDATE SET enabled=excluded.enabled, config_json=excluded.config_json, installed_at=excluded.installed_at').run(parts[2], wallet, skillId, 1, '{}', timestamp);
    audit(wallet, 'agent_skill', `${parts[2]}:${skillId}`, 'agent_skill_installed', { agentId: parts[2], skillId });
    return json(res, 201, { ok: true, data: { id: skillId, enabled: true, config: {}, installedAt: timestamp } });
  }
  if (req.method === 'GET' && parts[0] === 'v1' && parts[1] === 'agents' && parts[2] && parts[3] === 'automations') {
    const wallet = sessionWallet(req);
    if (!wallet) return json(res, 401, { ok: false, error: 'wallet_session_required' });
    const agent = db.prepare('SELECT owner_wallet FROM agents WHERE id = ?').get(parts[2]);
    if (!agent) return json(res, 404, { ok: false, error: 'agent_not_found' });
    if (agent.owner_wallet !== wallet) return json(res, 403, { ok: false, error: 'agent_owner_required' });
    const rows = db.prepare('SELECT * FROM agent_automations WHERE agent_id = ? AND owner_wallet = ? ORDER BY created_at DESC').all(parts[2], wallet);
    return json(res, 200, { ok: true, data: rows.map((row) => ({ id: row.id, task: row.task, schedule: JSON.parse(row.schedule_json), enabled: Boolean(row.enabled), nextRunAt: row.next_run_at, lastRunAt: row.last_run_at, lastResult: row.last_result_json ? JSON.parse(row.last_result_json) : null, createdAt: row.created_at, updatedAt: row.updated_at })) });
  }
  if (req.method === 'POST' && parts[0] === 'v1' && parts[1] === 'agents' && parts[2] && parts[3] === 'automations') {
    const wallet = sessionWallet(req);
    if (!wallet) return json(res, 401, { ok: false, error: 'wallet_session_required' });
    const agent = db.prepare('SELECT owner_wallet FROM agents WHERE id = ?').get(parts[2]);
    if (!agent) return json(res, 404, { ok: false, error: 'agent_not_found' });
    if (agent.owner_wallet !== wallet) return json(res, 403, { ok: false, error: 'agent_owner_required' });
    const body = await readBody(req);
    const task = cleanText(body.task, 2_000);
    if (!task) return json(res, 400, { ok: false, error: 'automation_task_required' });
    const schedule = body.schedule && typeof body.schedule === 'object' ? body.schedule : null;
    if (!schedule) return json(res, 400, { ok: false, error: 'automation_schedule_required' });
    try {
      const automation = createAutomation(db, { agentId: parts[2], ownerWallet: wallet, task, schedule });
      audit(wallet, 'agent_automation', automation.id, 'automation_created', { agentId: parts[2], schedule });
      return json(res, 201, { ok: true, data: automation });
    } catch (error) {
      if (String(error?.message) === 'invalid_automation_schedule') return json(res, 400, { ok: false, error: 'invalid_automation_schedule' });
      throw error;
    }
  }
  if (req.method === 'DELETE' && parts[0] === 'v1' && parts[1] === 'agents' && parts[2] && parts[3] === 'memory' && parts[4]) {
    const wallet = sessionWallet(req);
    if (!wallet) return json(res, 401, { ok: false, error: 'wallet_session_required' });
    const agent = db.prepare('SELECT owner_wallet FROM agents WHERE id = ?').get(parts[2]);
    if (!agent) return json(res, 404, { ok: false, error: 'agent_not_found' });
    if (agent.owner_wallet !== wallet) return json(res, 403, { ok: false, error: 'agent_owner_required' });
    const row = db.prepare('SELECT id FROM agent_memory WHERE agent_id = ? AND id = ?').get(parts[2], parts[4]);
    if (!row) return json(res, 404, { ok: false, error: 'memory_not_found' });
    db.prepare('DELETE FROM agent_memory WHERE agent_id = ? AND id = ?').run(parts[2], parts[4]);
    audit(wallet, 'agent_memory', parts[4], 'memory_deleted', { agentId: parts[2] });
    return json(res, 200, { ok: true, deleted: parts[4] });
  }

  if (req.method === 'GET' && parts[0] === 'v1' && parts[1] === 'agents' && parts[2] && parts[3] === 'audit') {
    const wallet = sessionWallet(req);
    if (!wallet) return json(res, 401, { ok: false, error: 'wallet_session_required' });
    const agent = db.prepare('SELECT owner_wallet FROM agents WHERE id = ?').get(parts[2]);
    if (!agent) return json(res, 404, { ok: false, error: 'agent_not_found' });
    if (agent.owner_wallet !== wallet) return json(res, 403, { ok: false, error: 'agent_owner_required' });
    const rows = db.prepare("SELECT id, actor_wallet, entity_type, entity_id, event_type, created_at FROM audit_events WHERE (entity_type = 'offering' AND entity_id IN (SELECT id FROM offerings WHERE agent_id = ?)) OR (entity_type = 'job' AND entity_id IN (SELECT j.id FROM jobs j JOIN offerings o ON o.id = j.offering_id WHERE o.agent_id = ?)) OR (entity_type = 'agent' AND entity_id = ?) ORDER BY created_at DESC").all(parts[2], parts[2], parts[2]);
    return json(res, 200, { ok: true, data: rows.map((event) => ({ id: event.id, actor: event.actor_wallet, entityType: event.entity_type, entityId: event.entity_id, eventType: event.event_type, createdAt: event.created_at })), total: rows.length });
  }

  if (req.method === 'GET' && parts[0] === 'v1' && parts[1] === 'agents' && parts[2] && parts[3] === 'registration') {
    const row = db.prepare('SELECT * FROM agents WHERE id = ?').get(parts[2]);
    if (!row) return json(res, 404, { ok: false, error: 'agent_not_found' });
    return json(res, 200, {
      type: 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1',
      name: row.name,
      description: row.description,
      image: row.image,
      services: JSON.parse(row.services_json),
      x402Support: Boolean(row.x402_support),
      active: row.status !== 'archived',
      supportedTrust: JSON.parse(row.supported_trust_json),
      registrations: [],
      coragentic: { status: row.status, chainId: CHAIN_ID, onchain: false, registries: REGISTRIES },
    });
  }
  if (req.method === 'GET' && parts[0] === 'v1' && parts[1] === 'agents' && parts[2]) {
    const row = db.prepare('SELECT * FROM agents WHERE id = ?').get(parts[2]);
    return row ? json(res, 200, { ok: true, data: agentResponse(row) }) : json(res, 404, { ok: false, error: 'agent_not_found' });
  }
  if (req.method === 'POST' && url.pathname === '/v1/agents') {
    const wallet = sessionWallet(req);
    if (!wallet) return json(res, 401, { ok: false, error: 'wallet_session_required' });
    const body = await readBody(req);
    const name = cleanText(body.name, 80);
    const description = cleanText(body.description, 2_000);
    const template = typeof body.template === 'string' && body.template.trim() ? body.template.trim() : 'blank';
    const services = Array.isArray(body.services) ? body.services.slice(0, 10) : [];
    const requestedCapabilities = Array.isArray(body.capabilities) ? body.capabilities.slice(0, 30).filter((x) => typeof x === 'string').map((x) => x.slice(0, 80)) : [];
    if (!name || !description) return json(res, 400, { ok: false, error: 'name_and_description_required' });
    if (!AGENT_TEMPLATE_IDS.includes(template)) return json(res, 400, { ok: false, error: 'invalid_agent_template' });
    const capabilities = requestedCapabilities.length ? requestedCapabilities : templateCapabilities(template);
    const id = `agent_${randomUUID().replaceAll('-', '')}`;
    const timestamp = new Date().toISOString();
    const starterVault = starterVaultForTemplate(template, { name, description });
    db.prepare(`INSERT INTO agents (id, owner_wallet, name, description, image, services_json, capabilities_json, supported_trust_json, x402_support, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, wallet, name, description, cleanText(body.image, 2_000), JSON.stringify(services), JSON.stringify(capabilities), JSON.stringify(['reputation']), 0, 'draft', timestamp, timestamp);
    const insertMemory = db.prepare('INSERT INTO agent_memory (id, agent_id, owner_wallet, memory_key, content, tags_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    for (const entry of starterVault) insertMemory.run(randomUUID(), id, wallet, entry.key, entry.content, JSON.stringify(entry.tags), timestamp, timestamp);
    const row = db.prepare('SELECT * FROM agents WHERE id = ?').get(id);
    audit(wallet, 'agent', id, 'agent_created', { status: 'draft', template, starterVaultRecords: starterVault.length });
    return json(res, 201, { ok: true, data: { ...agentResponse(row), template, starterVaultRecords: starterVault.length }, note: 'draft_only_identity_not_registered_onchain' });
  }
  return json(res, 404, { ok: false, error: 'route_not_found' });
}

const server = createServer((req, res) => {
  handle(req, res).catch((error) => {
    const publicError = formatPublicError(error, { code: 'request_invalid' });
    console.error(`[${publicError.correlationId}]`, error);
    json(res, 400, publicError);
  });
});
server.listen(PORT, () => console.log(`Coragentic API listening on http://127.0.0.1:${PORT}`));
startAutomationLoop({ db, audit, intervalMs: Number(process.env.CORAGENTIC_AUTOMATION_INTERVAL_MS || 60_000) });
