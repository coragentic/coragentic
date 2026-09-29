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

// listSteps/getStep power the Swarms UI's run-detail view, which reads
// step.stepKey (camelCase) directly. The DB column is step_key (snake_case);
// without mapping it, every step row has stepKey === undefined and the
// frontend's step.stepKey.replace(...) throws, taking the whole page blank
// (reproduced live: /app/swarms rendered pure black with a console
// TypeError "Cannot read properties of undefined (reading 'replace')").
test('listSteps and getStep expose camelCase stepKey, not just the raw step_key column', () => {
  const database = db();
  const state = new SwarmState(database);
  const runId = state.createRun({ goal: 'ship', sharedEvidence: {} });
  state.upsertStep(runId, { key: 'worker:alpha', input: {}, status: 'completed' });

  const listed = state.listSteps(runId);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].stepKey, 'worker:alpha');
  assert.equal(typeof listed[0].step_key, 'undefined', 'raw snake_case column should not leak to API consumers');

  const single = state.getStep(runId, 'worker:alpha');
  assert.equal(single.stepKey, 'worker:alpha');
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

// noulGate() called adapter.noul(mergedObject) -- a SINGLE argument -- but a
// real decision-adapter's noul(input, options) expects TWO separate
// arguments and reads the threshold off `options`, not off `input`. With
// only one argument, `options` defaulted to {} internally and every
// threshold comparison compared the live probability against undefined,
// which is always false -- so noul() ALWAYS reported not-allowed regardless
// of confidence, and every real run was rejected no matter how good the
// worker's answer was (reproduced live: confidence 0.95, score 0.93, still
// rejected). This asserts threshold actually reaches the adapter's options.
test('noulGate forwards the threshold to the adapter as options, not just inside the merged input', async () => {
  const seenOptions = [];
  const adapter = { noul: async (input, options) => { seenOptions.push(options); return { allowed: true, confidence: 1 }; } };
  await noulGate(adapter, { score: 1, threshold: 0.42, criteria: { true: 'allow', false: 'deny' } });
  assert.equal(seenOptions.length, 1);
  assert.equal(seenOptions[0]?.threshold, 0.42, 'the adapter must receive threshold via options, not buried in input');
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

// The jev judge previously only saw the step's INPUT (goal, worker id,
// context metadata) -- never the worker's actual result/answer. A judge
// that never sees what it's supposed to be scoring can only guess, so real
// runs came back rejected almost regardless of answer quality (reproduced
// live: a worker that answered correctly with confidence 0.95 still scored
// 0.16 and was rejected). The judge's state must include the produced result.
test('the score/noul decision state includes the worker result, not just its input', async () => {
  const database = db();
  const state = new SwarmState(database);
  const runId = state.createRun({ goal: 'answer well' });
  const seenStates = [];
  const seenInstructions = [];
  const adapter = {
    score: async (input) => { seenStates.push(input.state); seenInstructions.push(input.instructions); return 1; },
    noul: async (input) => { seenStates.push(input.state); seenInstructions.push(input.instructions); return { allowed: true }; },
  };
  await runSwarm(state, runId, [{ key: 'a' }], async () => ({ answer: 'the real answer', confidence: 0.95 }), { adapter, threshold: 0.5 });
  assert.ok(seenStates.length >= 2, 'both score and noul should have been called');
  for (const seenState of seenStates) {
    assert.ok(seenState.result, 'decision state must include the worker result');
    assert.equal(seenState.result.answer, 'the real answer');
  }
  // A judge given no goal-specific instructions can only guess at what
  // "approve" means (reproduced live: a correct answer at confidence 0.95
  // scored 0.72 -- middling -- and was still rejected, because the judge was
  // never told what goal it was scoring against).
  for (const instructions of seenInstructions) {
    assert.match(instructions, /answer well/, 'instructions should reference the run goal');
  }
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
