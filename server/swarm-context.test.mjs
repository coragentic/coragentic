import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { migrateRagSchema, indexMemory } from './rag.mjs';
import { SwarmState, createBoundedContextInput, runSwarm } from './swarm.mjs';

function db() {
  const database = new DatabaseSync(':memory:');
  database.exec(`CREATE TABLE agent_memory (
    id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, owner_wallet TEXT NOT NULL,
    memory_key TEXT NOT NULL, content TEXT NOT NULL, tags_json TEXT NOT NULL,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(agent_id, memory_key)
  )`);
  migrateRagSchema(database);
  return database;
}

function memory(database, id, agentId, ownerWallet, content) {
  database.prepare('INSERT INTO agent_memory VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, agentId, ownerWallet, id, content, '[]', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
  indexMemory(database, { id, memoryKey: id, content, tags: [] });
}

test('injects a bounded agent-scoped context pack and persists metadata only', async () => {
  const database = db();
  memory(database, 'mine', 'agent-a', 'owner-a', 'private deployment instruction');
  memory(database, 'other', 'agent-b', 'owner-b', 'other owner secret');
  // no ownerWallet provided: no filtering by owner, just by agentId
  const context = createBoundedContextInput(database, { agentId: 'agent-a', query: 'deployment' }, { ownerWallet: undefined, budget: 80 });
  assert.equal(context.agentId, 'agent-a');
  assert.equal(context.query, 'deployment');
  assert.ok(context.text.length <= 80);
  assert.match(context.text, /private deployment/);
  assert.doesNotMatch(context.text, /other owner secret/);
  assert.deepEqual(context.evidence.map(({ id }) => id), ['mine']);

  const state = new SwarmState(database, { actor: 'owner-a' });
  const runId = state.createRun({ goal: 'deploy', sharedEvidence: { context: context.metadata } });
  let received;
  await runSwarm(state, runId, [{ key: 'declared-worker', input: { context } }], async (step) => {
    received = step.input.context;
    return { workerId: 'declared-worker', status: 'declared' };
  }, { adapter: { score: async () => 1, noul: async () => ({ status: 'approved' }) } });
  assert.equal(received.text, context.text);
  const saved = state.getRun(runId);
  assert.deepEqual(saved.sharedEvidence.context.evidence, undefined); // evidence not in metadata anymore
  // verify evidenceCount is persisted instead
  assert.equal(saved.sharedEvidence.context.evidenceCount, 1);
  assert.equal(JSON.stringify(saved.sharedEvidence).includes('private deployment instruction'), false);
  assert.equal(database.prepare('SELECT payload_json FROM audit_events WHERE entity_id = ?').all(runId).some((row) => row.payload_json.includes('private deployment instruction')), false);
});

test('rejects malformed or cross-owner context requests before recall', () => {
  const database = db();
  memory(database, 'mine', 'agent-a', 'owner-a', 'private deployment instruction');
  assert.throws(() => createBoundedContextInput(database, { agentId: 'agent-a', query: 'deployment' }, { ownerWallet: 'owner-b' }), /agent_owner_required/);
  assert.throws(() => createBoundedContextInput(database, { agentId: 'agent-a', query: '' }), /query is required/);
});
