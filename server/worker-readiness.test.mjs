import assert from 'node:assert/strict';
import test from 'node:test';
import { getWorkerReadiness } from './worker-readiness.mjs';

test('worker readiness reports an unconfigured executor without exposing its environment', async () => {
  const state = await getWorkerReadiness({ executorUrl: '' });
  assert.deepEqual(state, { configured: false, ready: false, reason: 'executor_not_configured' });
});

test('worker readiness rejects malformed executor URLs without exposing them', async () => {
  const secretPath = '/private/worker/secret-executor.mjs';
  const state = await getWorkerReadiness({ executorUrl: secretPath });
  assert.deepEqual(state, { configured: true, ready: false, reason: 'executor_url_invalid' });
  assert.equal(JSON.stringify(state).includes(secretPath), false);
});

test('worker readiness rejects modules without a default executor function', async () => {
  const state = await getWorkerReadiness({
    executorUrl: 'file:///injected/malformed.mjs',
    importModule: async () => ({ default: 'not-a-function' }),
  });
  assert.deepEqual(state, { configured: true, ready: false, reason: 'executor_export_invalid' });
});

test('worker readiness accepts an injected executor module without invoking it', async () => {
  let calls = 0;
  const state = await getWorkerReadiness({
    executorUrl: 'file:///injected/valid.mjs',
    importModule: async () => ({ default: async () => { calls += 1; } }),
  });
  assert.deepEqual(state, { configured: true, ready: true, reason: null });
  assert.equal(calls, 0);
});
