import test from 'node:test';
import assert from 'node:assert/strict';
import { SwarmState, runSwarm, migrateSwarmSchema } from './swarm.mjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from './db.mjs';

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'swarm-ordering-'));
  const db = openDatabase(join(dir, 'db.sqlite'));
  migrateSwarmSchema(db);
  return { dir, db, state: new SwarmState(db, { actor: '0xdead' }) };
}

test('a rejected support worker does not fail the run when the primary answer completed', async () => {
  const { dir, db, state } = setup();
  try {
    const runId = state.createRun({ goal: 'g', sharedEvidence: {} });
    const steps = [
      { key: 'worker:context-worker', input: { worker: { id: 'context-worker', capabilities: ['context', 'analysis'] } } },
      { key: 'worker:analyst', input: { worker: { id: 'analyst', capabilities: ['analysis'] } } },
    ];
    const run = await runSwarm(state, runId, steps, async (step) => (
      step.input.worker.capabilities.includes('context')
        ? { status: 'answered', answer: 'grounded answer', confidence: 0.9, citedEvidenceIds: [] }
        : { status: 'answered', answer: 'review note', confidence: 0.6, citedEvidenceIds: [] }
    ), { concurrency: 4, adapter: {} }); // offline adapter: noul always denies -> per-step rejected
    // The PRIMARY grounded answer completed; a secondary worker being gated
    // must not flip the whole run to rejected when one real answer exists.
    assert.equal(run.status, 'completed');
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('a run where no step completed is rejected honestly', async () => {
  const { dir, db, state } = setup();
  try {
    const runId = state.createRun({ goal: 'g', sharedEvidence: {} });
    const steps = [{ key: 'worker:context-worker', input: { worker: { id: 'context-worker', capabilities: ['context'] } } }];
    const run = await runSwarm(state, runId, steps, async () => ({ status: 'no_evidence', answer: '', confidence: 0, citedEvidenceIds: [] }), { concurrency: 1, adapter: {} });
    assert.equal(run.status, 'rejected');
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});
