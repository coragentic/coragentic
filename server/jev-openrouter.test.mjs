import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createOpenRouterJevAdapter,
  createOpenRouterJevAdapterFromEnv,
} from './jev-openrouter.mjs';

const response = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const state = { ticket: 'checkout is blank' };

test('sends an authenticated Decisions choice request using explicit state only', async () => {
  let request;
  const adapter = createOpenRouterJevAdapter({
    apiKey: 'test-key',
    fetch: async (url, init) => {
      request = { url, init };
      return response({ id: 'dec_1', model: 'typesafe/jev-1.13-20260917', provider: 'TypeSafe', usage: { input_tokens: 3 }, state, answers: {
        decision: { type: 'choice', choice: 'approve', confidence: 0.9, probabilities: { approve: 0.9, reject: 0.1 } },
      } });
    },
  });

  const result = await adapter.choice({
    state,
    choices: ['approve', 'reject'],
    instructions: 'Choose the safe action.',
    criteria: { approve: 'Safe to approve.', reject: 'Unsafe to approve.' },
    memory: 'must never be sent',
  });

  assert.equal(request.url, 'https://openrouter.ai/api/alpha/decisions');
  assert.equal(request.init.method, 'POST');
  assert.equal(request.init.headers.Authorization, 'Bearer test-key');
  assert.equal(request.init.headers['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(request.init.body), {
    model: 'typesafe/jev-1.13', state, questions: {
      decision: { type: 'choice', instructions: 'Choose the safe action.', criteria: { approve: 'Safe to approve.', reject: 'Unsafe to approve.' } },
    },
  });
  assert.equal(result.choice, 'approve');
  assert.equal(result.confidence, 0.9);
  assert.equal(result.provider, 'openrouter-jev');
  assert.equal(result.metadata.openrouter.id, 'dec_1');
  assert.deepEqual(result.metadata.openrouter.usage, { input_tokens: 3 });
  assert.deepEqual(result.metadata.openrouter.answers.decision.probabilities, { approve: 0.9, reject: 0.1 });
  assert.equal(JSON.stringify(result.metadata).includes('checkout is blank'), false);
  assert.equal(JSON.stringify(result.metadata).includes('must never be sent'), false);
});

test('normalizes Jev weighted score by the ordered criteria range', async () => {
  const adapter = createOpenRouterJevAdapter({
    apiKey: 'test-key',
    fetch: async () => response({ answers: {
      decision: { type: 'score', score: 1.5, confidence: 0.8, probabilities: { 0: 0, 1: 0.5, 2: 0.5 } },
    } }),
  });

  const result = await adapter.score({ state, instructions: 'Rate urgency.', criteria: ['low', 'medium', 'high'] });
  assert.equal(result.score, 0.75);
  assert.equal(result.confidence, 0.8);
  assert.equal(result.provider, 'openrouter-jev');
});

test('maps noul yes probability to allowed only strictly above threshold', async () => {
  const adapter = createOpenRouterJevAdapter({
    apiKey: 'test-key',
    fetch: async () => response({ answers: { decision: { type: 'noul', noul: 0.8 } } }),
  });

  const equal = await adapter.noul({ state, instructions: 'Allow?', criteria: { true: 'allow', false: 'deny' } }, { threshold: 0.8 });
  const above = await adapter.noul({ state, instructions: 'Allow?', criteria: { true: 'allow', false: 'deny' } }, { threshold: 0.79 });
  assert.equal(equal.allowed, false);
  assert.equal(above.allowed, true);
  assert.equal(above.confidence, 0.8);
});

test('falls back offline on timeout, HTTP failure, malformed response, and oversized state', async () => {
  const fallback = async (fetch) => createOpenRouterJevAdapter({ apiKey: 'test-key', fetch, timeout: 5 })
    .choice({ state, choices: ['safe', 'unsafe'], instructions: 'Choose.', criteria: { safe: 'safe', unsafe: 'unsafe' } });

  for (const fetch of [
    async () => new Promise(() => {}),
    async () => response({ error: 'nope' }, 503),
    async () => response({ answers: { decision: { type: 'choice', choice: 7 } } }),
  ]) {
    const result = await fallback(fetch);
    assert.equal(result.provider, 'offline');
    assert.equal(result.choice, 'safe');
  }

  let called = false;
  const oversized = createOpenRouterJevAdapter({ apiKey: 'test-key', maxStateBytes: 8, fetch: async () => { called = true; return response({}); } });
  const result = await oversized.choice({ state, choices: ['safe'], instructions: 'Choose.', criteria: { safe: 'safe' } });
  assert.equal(called, false);
  assert.equal(result.provider, 'offline');
});

test('uses the offline fallback without a key and reads optional environment configuration', async () => {
  const absent = createOpenRouterJevAdapter({ fetch: async () => { throw new Error('must not fetch'); } });
  assert.equal((await absent.choice({ state, choices: ['safe'] })).provider, 'offline');

  const adapter = createOpenRouterJevAdapterFromEnv({
    env: { OPENROUTER_API_KEY: 'from-env', CORAGENTIC_JEV_MODEL: 'custom/jev', CORAGENTIC_JEV_TIMEOUT_MS: '17' },
    fetch: async (url, init) => {
      assert.equal(init.headers.Authorization, 'Bearer from-env');
      assert.equal(JSON.parse(init.body).model, 'custom/jev');
      return response({ answers: { decision: { type: 'choice', choice: 'safe', confidence: 1 } } });
    },
  });
  assert.equal((await adapter.choice({ state, choices: ['safe'] })).provider, 'openrouter-jev');
});
