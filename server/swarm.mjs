import { randomUUID } from 'node:crypto';
import { contextPack } from './rag.mjs';

const now = () => new Date().toISOString();
const json = (value) => JSON.stringify(value ?? {});
const parse = (value, fallback = {}) => {
  try { return value == null ? fallback : JSON.parse(value); } catch { return fallback; }
};

export function migrateSwarmSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS swarm_runs (
      id TEXT PRIMARY KEY, goal TEXT NOT NULL, status TEXT NOT NULL,
      shared_evidence_json TEXT NOT NULL DEFAULT '{}', threshold REAL NOT NULL DEFAULT 0.5,
      human_escalation TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS swarm_steps (
      id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES swarm_runs(id), step_key TEXT NOT NULL,
      status TEXT NOT NULL, input_json TEXT NOT NULL DEFAULT '{}', output_json TEXT,
      score REAL, error TEXT, started_at TEXT, completed_at TEXT, updated_at TEXT NOT NULL,
      UNIQUE(run_id, step_key)
    );
    CREATE INDEX IF NOT EXISTS idx_swarm_steps_run ON swarm_steps(run_id, step_key);
    CREATE TABLE IF NOT EXISTS audit_events (
      id TEXT PRIMARY KEY, actor_wallet TEXT NOT NULL, entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL, event_type TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_events(entity_type, entity_id, created_at);
    CREATE TABLE IF NOT EXISTS worker_heartbeat (
      id INTEGER PRIMARY KEY CHECK(id = 1),
      worker_id TEXT, ready INTEGER NOT NULL DEFAULT 0, reason TEXT, updated_at TEXT NOT NULL
    );
  `);
}

export class SwarmState {
  constructor(db, { actor = 'swarm' } = {}) {
    this.db = db; this.actor = actor; migrateSwarmSchema(db);
  }

  audit(runId, eventType, payload = {}) {
    this.db.prepare('INSERT INTO audit_events (id, actor_wallet, entity_type, entity_id, event_type, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(randomUUID(), this.actor, 'swarm', runId, eventType, json(payload), now());
  }

  createRun({ id = randomUUID(), goal, sharedEvidence = {}, threshold = 0.5 } = {}) {
    if (!goal || typeof goal !== 'string') throw new TypeError('goal is required');
    const stamp = now();
    this.db.prepare('INSERT INTO swarm_runs (id, goal, status, shared_evidence_json, threshold, human_escalation, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, goal, 'pending', json(sharedEvidence), Number(threshold), null, stamp, stamp);
    this.audit(id, 'swarm_created', { goal });
    return id;
  }

  updateRun(id, patch = {}) {
    const current = this.getRun(id);
    if (!current) throw new Error(`swarm run not found: ${id}`);
    const status = patch.status ?? current.status;
    const evidence = patch.sharedEvidence ?? current.sharedEvidence;
    const escalation = patch.humanEscalation ?? current.humanEscalation;
    this.db.prepare('UPDATE swarm_runs SET status = ?, shared_evidence_json = ?, human_escalation = ?, updated_at = ? WHERE id = ?')
      .run(status, json(evidence), escalation, now(), id);
    this.audit(id, 'swarm_updated', { status, humanEscalation: escalation });
    return this.getRun(id);
  }

  getRun(id) {
    const row = this.db.prepare('SELECT * FROM swarm_runs WHERE id = ?').get(id);
    return row && { ...row, sharedEvidence: parse(row.shared_evidence_json), humanEscalation: row.human_escalation };
  }

  getStep(runId, stepKey) {
    const row = this.db.prepare('SELECT * FROM swarm_steps WHERE run_id = ? AND step_key = ?').get(runId, stepKey);
    return row && { ...row, input: parse(row.input_json), output: parse(row.output_json, null) };
  }

  listSteps(runId) { return this.db.prepare('SELECT * FROM swarm_steps WHERE run_id = ? ORDER BY rowid').all(runId).map((row) => ({ ...row, input: parse(row.input_json), output: parse(row.output_json, null) })); }

  upsertStep(runId, step, patch = {}) {
    const key = step.key ?? step.stepKey;
    if (!key) throw new TypeError('step key is required');
    const previous = this.getStep(runId, key);
    const value = { status: 'pending', input: step.input ?? {}, output: undefined, score: null, error: null, ...step, ...patch };
    const stamp = now();
    if (!previous) {
      this.db.prepare('INSERT INTO swarm_steps (id, run_id, step_key, status, input_json, output_json, score, error, started_at, completed_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(randomUUID(), runId, key, value.status, json(value.input), value.output === undefined ? null : json(value.output), value.score, value.error, value.startedAt ?? null, value.completedAt ?? null, stamp);
    } else {
      this.db.prepare('UPDATE swarm_steps SET status = ?, input_json = ?, output_json = ?, score = ?, error = ?, started_at = ?, completed_at = ?, updated_at = ? WHERE run_id = ? AND step_key = ?')
        .run(value.status, json(value.input ?? previous.input), value.output === undefined ? (previous.output == null ? null : json(previous.output)) : json(value.output), value.score ?? previous.score, value.error ?? previous.error, value.startedAt ?? previous.started_at, value.completedAt ?? previous.completed_at, stamp, runId, key);
    }
    this.audit(runId, 'swarm_step_updated', { stepKey: key, status: value.status });
    return this.getStep(runId, key);
  }
}

export function deterministicChoice({ candidates = [], capabilities = [] } = {}) {
  const raw = Array.isArray(candidates) ? candidates : [];
  const allStrings = raw.every((candidate) => typeof candidate === 'string');
  const list = raw.map((candidate) => typeof candidate === 'string' ? { id: candidate, capabilities: [] } : candidate).filter(Boolean);
  const wanted = new Set(Array.isArray(capabilities) ? capabilities : []);
  const selected = list.sort((a, b) => String(a.id ?? a.name).localeCompare(String(b.id ?? b.name))
    || String(a.name ?? '').localeCompare(String(b.name ?? '')))
    .find((candidate) => !wanted.size || (candidate.capabilities || []).some((capability) => wanted.has(capability))) || list[0] || null;
  return selected && allStrings ? selected.id : selected;
}

// Only a requested, bounded retrieval pack crosses into a run. Durable state
// keeps provenance-like metadata, never the private retrieval text/content.
export function createBoundedContextInput(db, request = {}, { ownerWallet, budget = 4_000 } = {}) {
  const agentId = typeof request.agentId === 'string' && request.agentId.trim();
  const rawQuery = typeof request.query === 'string' ? request.query.trim() : '';
  const query = rawQuery.slice(0, 160); // cap at 160 chars before retrieval and persistence
  if (!agentId) throw new TypeError('agentId is required');
  if (!query) throw new TypeError('query is required');
  if (ownerWallet) {
    const owner = db.prepare('SELECT owner_wallet FROM agent_memory WHERE agent_id = ? AND owner_wallet = ? LIMIT 1').get(agentId, ownerWallet)?.owner_wallet
      ?? db.prepare('SELECT owner_wallet FROM agent_memory WHERE agent_id = ? LIMIT 1').get(agentId)?.owner_wallet;
    if (owner && owner !== ownerWallet) throw new Error('agent_owner_required');
  }
  const pack = contextPack(db, query, Math.min(4_000, Math.max(0, Number(budget) || 0)), { agentId, ownerWallet });
  const evidence = pack.evidence.map(({ id, key, timestamp, tags }) => ({ id, key, timestamp, tags }));
  // Metadata persisted and sent externally contains only opaque IDs/counts, never query/key/tag raw content
  return {
    agentId,
    query,
    text: pack.text,
    evidence,
    metadata: { agentId, budget: pack.budget, evidenceCount: evidence.length, semanticEmbeddings: pack.semanticEmbeddings },
  };
}

export class CapabilityRouter {
  constructor({ choice } = {}) { this.adapter = choice; }
  async choose(input = {}) {
    const selected = this.adapter ? await this.adapter(input) : deterministicChoice(input);
    return { choice: selected?.choice ?? selected, source: this.adapter ? 'adapter' : 'fallback' };
  }
  route(input) { return this.choose(input); }
}

export async function dispatchWorkers(items, worker, { concurrency = 4 } = {}) {
  const limit = Math.max(1, Math.floor(Number(concurrency) || 1));
  const results = new Array(items.length); let cursor = 0;
  async function consume() {
    while (true) { const index = cursor++; if (index >= items.length) return; results[index] = await worker(items[index], index); }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, consume));
  return results;
}

export async function scoreResult(adapter = {}, input = {}) {
  if (typeof adapter.score === 'function') {
    const value = await adapter.score(input);
    return Number(value?.score ?? value);
  }
  if (typeof input.result?.score === 'number') return input.result.score;
  return input.result == null ? 0 : 1;
}

export async function noulGate(adapter = {}, { score = 0, threshold = 0.5, ...input } = {}) {
  if (typeof adapter.noul === 'function') {
    const result = await adapter.noul({ score, threshold, ...input });
    const status = result?.status ?? (result?.allowed === false || result?.allow === false ? 'rejected' : 'approved');
    return { ...result, status };
  }
  return { status: score >= threshold ? 'approved' : 'rejected', score, threshold };
}

export async function runSwarm(state, runId, steps, worker, { concurrency = 4, adapter = {}, threshold } = {}) {
  const run = state.getRun(runId);
  if (!run) throw new Error(`swarm run not found: ${runId}`);
  const effectiveThreshold = threshold ?? run.threshold;
  state.updateRun(runId, { status: 'running' });
  const pending = [];
  for (const step of steps) {
    const existing = state.getStep(runId, step.key ?? step.stepKey);
    if (existing?.status === 'completed' || existing?.status === 'approved') continue;
    state.upsertStep(runId, step, { status: 'running', startedAt: now() });
    pending.push(step);
  }
  await dispatchWorkers(pending, async (step) => {
    const key = step.key ?? step.stepKey;
    try {
      const result = await worker(step, { run: state.getRun(runId), evidence: state.getRun(runId).sharedEvidence });
      // Decision providers receive explicit, persisted-safe state only; the bounded
      // private context remains available to the declared worker, not the provider.
      const decisionState = { goal: run.goal, step: { key, input: step.input }, context: state.getRun(runId).sharedEvidence.context };
      const score = await scoreResult(adapter, { runId, step, result, state: decisionState, criteria: ['reject', 'approve'] });
      const gate = await noulGate(adapter, { runId, step, result, score, threshold: effectiveThreshold, state: decisionState, criteria: { true: 'allow', false: 'deny' } });
      const status = gate.status === 'human_escalation' ? 'human_escalation' : gate.status === 'rejected' ? 'rejected' : 'completed';
      state.upsertStep(runId, step, { status, output: result, score, error: gate.reason ?? null, completedAt: now() });
      const current = state.getRun(runId);
      const evidence = { ...current.sharedEvidence, [key]: result };
      state.updateRun(runId, { status, sharedEvidence: evidence, humanEscalation: status === 'human_escalation' ? (gate.reason || 'human review required') : current.humanEscalation });
      return { step: key, result, score, gate };
    } catch (error) {
      state.upsertStep(runId, step, { status: 'failed', error: error.message, completedAt: now() });
      throw error;
    }
  }, { concurrency });
  const finalSteps = state.listSteps(runId);
  const status = finalSteps.some((step) => step.status === 'human_escalation') ? 'human_escalation' : finalSteps.some((step) => step.status === 'rejected') ? 'rejected' : finalSteps.every((step) => ['completed', 'approved'].includes(step.status)) ? 'completed' : 'running';
  return state.updateRun(runId, { status });
}

export const createSwarmState = (db, options) => new SwarmState(db, options);
export const routeCapability = (input, options) => new CapabilityRouter(options).choose(input);
