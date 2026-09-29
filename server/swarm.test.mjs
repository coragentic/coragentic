import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  SwarmState,
  CapabilityRouter,
  dispatchWorkers,
  scoreResult,
  noulGate,
  runSwarm,
} from './swarm.mjs';

function db() { return new DatabaseSync(':memory:'); }

test('persists runs, steps, shared evidence, and audit events', () => {
  const database = db();
  const state = new SwarmState(database);
  const runId = state.createRun({ goal: 'ship', sharedEvidence: { seed: 1 } });
  state.upsertStep(runId, { key: 'a', input: { x: 1 }, status: 'completed', output: { ok: true } });
  state.updateRun(runId, { status: 'running', sharedEvidence: { seed: 1, answer: 42 } });
  assert.equal(state.getRun(runId).goal, 'ship');
  assert.deepEqual(state.getRun(runId).sharedEvidence, { seed: 1, answer: 42 });
  assert.equal(state.getStep(runId, 'a').status, 'completed');
  assert.equal(database.prepare('SELECT count(*) AS n FROM audit_events WHERE entity_id = ?').get(runId).n, 3);
});

test('routes through injected choice and deterministic fallback', async () => {
  const seen = [];
  const routed = await new CapabilityRouter({ choice: async (p) => { seen.push(p); return 'b'; } }).choose({ goal: 'g', candidates: ['a', 'b'] });
  assert.equal(routed.choice, 'b');
  assert.equal(seen.length, 1);
  assert.equal((await new CapabilityRouter().choose({ candidates: ['z', 'a'] })).choice, 'a');
});

test('dispatches workers in parallel with bounded concurrency', async () => {
  let active = 0; let peak = 0;
  const results = await dispatchWorkers([1, 2, 3, 4], async (item) => {
    active++; peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 10));
    active--; return item * 2;
  }, { concurrency: 2 });
  assert.deepEqual(results, [2, 4, 6, 8]);
  assert.equal(peak, 2);
});

test('scores results and rejects below threshold', async () => {
  assert.equal(await scoreResult({ score: async () => 0.2 }, { result: 'x' }), 0.2);
  assert.equal(await scoreResult({}, { result: { ok: true } }), 1);
  const gate = await noulGate({}, { score: 0.2, threshold: 0.5 });
  assert.equal(gate.status, 'rejected');
});

test('noul escalates to human_escalation', async () => {
  const gate = await noulGate({ noul: async () => ({ status: 'human_escalation', reason: 'risk' }) }, { score: 1, threshold: 0.5 });
  assert.equal(gate.status, 'human_escalation');
});

test('resume is idempotent by step and does not rerun completed work', async () => {
  const database = db();
  const state = new SwarmState(database);
  const runId = state.createRun({ goal: 'resume' });
  let calls = 0;
  const first = await runSwarm(state, runId, [{ key: 'a' }, { key: 'b' }], async (step) => { calls++; return { key: step.key }; });
  assert.equal(first.status, 'completed');
  const second = await runSwarm(state, runId, [{ key: 'a' }, { key: 'b' }], async () => { calls++; return {}; });
  assert.equal(second.status, 'completed');
  assert.equal(calls, 2);
});

test('concurrent workers writing shared evidence do not lose each other\'s results (lost-update race)', async () => {
  const database = db();
  const state = new SwarmState(database);
  const runId = state.createRun({ goal: 'race' });
  // 8 steps at concurrency 4, matching the API's real defaults (server/index.mjs).
  // Each worker yields the event loop for a jittered delay BEFORE returning, so
  // multiple workers are genuinely mid-flight (both past their read of current
  // sharedEvidence) when they each go to merge their own key in and write back --
  // exactly the interleaving that causes a read-modify-write race.
  const keys = Array.from({ length: 8 }, (_, i) => `step-${i}`);
  const steps = keys.map((key) => ({ key }));
  const delays = [7, 1, 6, 2, 5, 3, 4, 8];
  const result = await runSwarm(state, runId, steps, async (step, index) => {
    const delayMs = delays[keys.indexOf(step.key ?? step.stepKey)];
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    return { key: step.key, index };
  }, { concurrency: 4 });
  assert.equal(result.status, 'completed');
  // Every one of the 8 workers' results must be present in the final shared
  // evidence -- a lost update means fewer than 8 keys survive the merge.
  const evidenceKeys = Object.keys(result.sharedEvidence).filter((key) => key.startsWith('step-'));
  assert.deepEqual(evidenceKeys.sort(), keys.slice().sort());
});
