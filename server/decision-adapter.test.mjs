import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createDecisionAdapter,
  createOfflineDecisionAdapter,
} from './decision-adapter.mjs';

test('routes choice and returns a strict typed response with provider metadata', async () => {
  const adapter = createDecisionAdapter({
    choice: async () => ({ choice: 'approve', confidence: 0.91 }),
  });

  assert.deepEqual(await adapter.choice({ task: 'review' }), {
    kind: 'choice', choice: 'approve', confidence: 0.91, threshold: 0.5,
    accepted: true, provider: 'jev', metadata: { provider: 'jev' },
  });
});

test('routes score and applies a validated confidence threshold', async () => {
  const adapter = createDecisionAdapter({ score: () => ({ score: 0.7, confidence: 0.8 }) });
  const result = await adapter.score('input', { threshold: 0.75 });
  assert.equal(result.kind, 'score');
  assert.equal(result.score, 0.7);
  assert.equal(result.accepted, true);
  assert.equal(result.threshold, 0.75);
});

test('noul is a gate and rejects confidence below threshold', async () => {
  const adapter = createDecisionAdapter({ noul: () => ({ allowed: true, confidence: 0.4 }) });
  const result = await adapter.noul('input', { threshold: 0.5 });
  assert.equal(result.kind, 'noul');
  assert.equal(result.allowed, false);
  assert.equal(result.confidence, 0.4);
  assert.equal(result.accepted, false);
});

test('times out an unavailable provider and uses the typed fallback', async () => {
  const adapter = createDecisionAdapter({
    choice: () => new Promise(() => {}),
    timeout: 10,
    fallback: ({ kind }) => ({ kind, choice: 'defer', confidence: 1 }),
  });
  const result = await adapter.choice('input');
  assert.deepEqual(result, {
    kind: 'choice', choice: 'defer', confidence: 1, threshold: 0.5,
    accepted: true, provider: 'fallback', metadata: { provider: 'fallback' },
  });
});

test('falls back when the injected provider returns a malformed result', async () => {
  const adapter = createDecisionAdapter({
    score: () => ({ score: 'not-a-number', confidence: 0.8 }),
    fallback: { score: 0.25, confidence: 1 },
  });
  const result = await adapter.score('input');
  assert.equal(result.kind, 'score');
  assert.equal(result.score, 0.25);
  assert.equal(result.provider, 'fallback');
});

test('batchChoice routes in parallel and preserves input order', async () => {
  const started = [];
  const adapter = createDecisionAdapter({
    choice: async (input) => {
      started.push(input.id);
      await new Promise((resolve) => setTimeout(resolve, input.delay));
      return { choice: input.id, confidence: 1 };
    },
  });
  const result = await adapter.batchChoice([
    { id: 'slow', delay: 20 },
    { id: 'fast', delay: 1 },
  ]);
  assert.deepEqual(started, ['slow', 'fast']);
  assert.deepEqual(result.map(({ choice }) => choice), ['slow', 'fast']);
});

test('offline adapter is deterministic and explicitly marked offline', async () => {
  const adapter = createOfflineDecisionAdapter();
  const first = await adapter.choice({ choices: ['safe', 'unsafe'] });
  const second = await adapter.choice({ choices: ['safe', 'unsafe'] });
  assert.deepEqual(first, second);
  assert.equal(first.provider, 'offline');
  assert.equal(first.metadata.provider, 'offline');
});

test('validates thresholds and provider confidence strictly', async () => {
  assert.throws(() => createDecisionAdapter({ timeout: 0 }), /timeout/);
  const adapter = createDecisionAdapter({ choice: () => ({ choice: 'x', confidence: 2 }) });
  const result = await adapter.choice('input');
  assert.equal(result.provider, 'offline');
  await assert.rejects(adapter.choice('input', { threshold: 1.1 }), /threshold/);
});
