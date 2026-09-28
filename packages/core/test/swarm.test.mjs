import test from 'node:test';
import assert from 'node:assert/strict';
import { createSwarmRuntime } from '../src/swarm.mjs';

test('runs three workers in parallel with a bounded concurrency limit', async () => {
  const running = { now: 0, max: 0 };
  const runtime = createSwarmRuntime({
    plan: { id: 'triage', workers: ['alpha', 'beta', 'gamma'].map((id) => ({ id, run: async (input) => { running.now += 1; running.max = Math.max(running.max, running.now); await new Promise((resolve) => setTimeout(resolve, 5)); running.now -= 1; return `${id}:${input}`; } })) },
    bounded: 2,
  });
  const result = await runtime.runParallel('job');
  assert.deepEqual(result.map((item) => item.result), ['alpha:job', 'beta:job', 'gamma:job']);
  assert.equal(running.max, 2);
  assert.equal(runtime.state.results.length, 3);
});

test('routes deterministically and gates an action with escalation and audit', async () => {
  const audit = [];
  const escalations = [];
  const runtime = createSwarmRuntime({
    plan: { id: 'guarded', workers: [{ id: 'safe', run: async () => 'ok' }] },
    gate: (action) => action.kind !== 'danger',
    escalate: (event) => escalations.push(event),
    audit: (event) => audit.push(event),
  });
  assert.equal(runtime.route('safe').id, 'safe');
  assert.equal(await runtime.gate({ id: 'a1', kind: 'danger' }), false);
  assert.equal(escalations.length, 1);
  assert.equal(audit.at(-1).status, 'rejected');
  await assert.rejects(runtime.runParallel([{ id: 'a1', action: { kind: 'danger' }, worker: 'safe' }]), /gated/);
});

test('deduplicates idempotent worker executions and uses fallback adapter without network', async () => {
  let calls = 0;
  const runtime = createSwarmRuntime({
    plan: { workers: [{ id: 'only', run: async () => { calls += 1; return 'done'; } }] },
  });
  const first = await runtime.runParallel([{ id: 'same', worker: 'only', input: 1 }]);
  const second = await runtime.runParallel([{ id: 'same', worker: 'only', input: 2 }]);
  assert.equal(calls, 1);
  assert.equal(first[0].result, 'done');
  assert.equal(second[0].result, 'done');
  assert.equal(second[0].idempotent, true);
  assert.equal(runtime.score({ value: 3 }), 3);
});
