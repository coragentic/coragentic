import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { isAddress, verifyMessage } from 'viem';
import { openDatabase, cleanupExpired } from './db.mjs';
import { migrateWorkerSchema } from './worker.mjs';
import { createRegistrationPayload, hashRegistrationPayload, registrationURI, buildRegisterCall, IDENTITY_REGISTRY_ADDRESS } from './identity.mjs';
import { createPaymentRequired, createX402Boundary, parsePaymentSignature, NETWORK as X402_NETWORK } from './x402.mjs';
import { createUsdgFacilitator } from './x402-facilitator.mjs';
import { createDirectTransferFacilitator } from './x402-onchain-verifier.mjs';
import { createRateLimiter, getCorsHeaders, getSecurityHeaders, formatPublicError } from './security.mjs';
import { migrateRagSchema, indexMemory, recall as ragRecall } from './rag.mjs';
import { buildAgentCard, buildMcpManifest } from './interoperability.mjs';
import { migrateSwarmSchema, SwarmState, createBoundedContextInput, runSwarm } from './swarm.mjs';
import { createOpenRouterJevAdapterFromEnv } from './jev-openrouter.mjs';
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
  let raw = '';
  for await (const chunk of req) raw += chunk;
  if (raw.length > 256_000) throw new Error('request body too large');
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
    const ready = heartbeat?.ready === 1;
    const stale = heartbeat && (Date.now() - new Date(heartbeat.updated_at).getTime() > 60_000);
    const data = { configured, ready: ready && !stale, reason: stale ? 'heartbeat_stale' : (heartbeat?.reason ?? (configured ? 'executor_configured_worker_not_running' : 'executor_not_configured')) };
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
    const rows = db.prepare(
      'SELECT sr.id, sr.status, sr.human_escalation, sr.created_at, sr.updated_at FROM swarm_runs sr JOIN audit_events ae ON ae.entity_type = \'swarm\' AND ae.entity_id = sr.id AND ae.actor_wallet = ? ORDER BY sr.updated_at DESC LIMIT 50'
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
    await runSwarm(state, runId, steps, async (step) => ({
      workerId: step.input.worker.id,
      capabilities: step.input.worker.capabilities,
      status: 'declared_not_executed',
      contextEvidenceCount: step.privateContext.evidence.length,
    }), { concurrency: 4, adapter: swarmDecisionAdapter });
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
  if (req.method === 'POST' && url.pathname === '/v1/auth/verify') {
    const body = await readBody(req);
    const wallet = normalizeWallet(body.wallet);
    const signature = cleanText(body.signature, 256);
    const nonce = cleanText(body.nonce, 80);
    if (!wallet || !signature || !nonce) return json(res, 400, { ok: false, error: 'wallet_signature_nonce_required' });
    const challenge = db.prepare('SELECT * FROM auth_challenges WHERE nonce = ? AND wallet = ?').get(nonce, wallet);
    if (!challenge || challenge.used_at || challenge.expires_at < now()) return json(res, 401, { ok: false, error: 'challenge_invalid_or_expired' });
    let valid = false;
    try { valid = await verifyMessage({ address: wallet, message: challenge.message, signature }); } catch { valid = false; }
    if (!valid) return json(res, 401, { ok: false, error: 'signature_invalid' });
    db.prepare('UPDATE auth_challenges SET used_at = ? WHERE nonce = ?').run(now(), nonce);
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
    // Atomic replay guard: tx_hash is PRIMARY KEY, so a concurrent duplicate settle
    // fails at the database layer, not via a check-then-act race in application code.
    try {
      db.prepare('INSERT INTO x402_settlements (tx_hash, offering_id, payer_wallet, amount_atomic, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(txHash, offering.id, result.payer, result.amount, new Date().toISOString());
    } catch {
      return json(res, 409, { ok: false, error: 'transaction_already_settled' });
    }
    audit(result.payer, 'offering', offering.id, 'x402_settled', { txHash, amount: result.amount });
    return json(res, 200, { ok: true, data: { status: 'settled', txHash, payer: result.payer, amount: result.amount, offeringId: offering.id } });
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
    let deliverable = row.deliverable_json;
    if (next === 'submitted') {
      deliverable = jsonValue(body.deliverable);
      if (!deliverable) return json(res, 400, { ok: false, error: 'deliverable_required' });
    } else if (body.deliverable !== undefined) {
      return json(res, 400, { ok: false, error: 'deliverable_not_allowed' });
    }
    const timestamp = new Date().toISOString();
    db.prepare('UPDATE jobs SET status = ?, deliverable_json = ?, updated_at = ? WHERE id = ?').run(next, deliverable, timestamp, row.id);
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
    const agent = db.prepare('SELECT owner_wallet FROM agents WHERE id = ?').get(parts[2]);
    if (!agent) return json(res, 404, { ok: false, error: 'agent_not_found' });
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
    const services = Array.isArray(body.services) ? body.services.slice(0, 10) : [];
    const capabilities = Array.isArray(body.capabilities) ? body.capabilities.slice(0, 30).filter((x) => typeof x === 'string').map((x) => x.slice(0, 80)) : [];
    if (!name || !description) return json(res, 400, { ok: false, error: 'name_and_description_required' });
    const id = `agent_${randomUUID().replaceAll('-', '')}`;
    const timestamp = new Date().toISOString();
    db.prepare(`INSERT INTO agents (id, owner_wallet, name, description, image, services_json, capabilities_json, supported_trust_json, x402_support, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, wallet, name, description, cleanText(body.image, 2_000), JSON.stringify(services), JSON.stringify(capabilities), JSON.stringify(['reputation']), 0, 'draft', timestamp, timestamp);
    const row = db.prepare('SELECT * FROM agents WHERE id = ?').get(id);
    audit(wallet, 'agent', id, 'agent_created', { status: 'draft' });
    return json(res, 201, { ok: true, data: agentResponse(row), note: 'draft_only_identity_not_registered_onchain' });
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
