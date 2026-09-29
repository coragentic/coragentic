import test from 'node:test';
import assert from 'node:assert/strict';
import { runContextWorker } from './swarm-context-worker.mjs';

// The swarm's "context-worker" step used to be a stub -- it declared it had
// capabilities and counted evidence, but never actually answered the
// query ({ status: 'declared_not_executed' }). The jev judge then had
// nothing real to score, and near-empty/non-answers score low against any
// reasonable threshold, so every run came back rejected. This worker
// actually generates an answer grounded in the retrieved evidence, so the
// judge has real work product to evaluate.
test('produces a real, grounded answer when the model responds with valid JSON', async () => {
  const calls = [];
  const fetchStub = async (url, init) => {
    calls.push({ url, init });
    return {
      ok: true,
      json: async () => ({
        choices: [{ message: { content: JSON.stringify({ answer: 'Ship the swarm worker fix.', confidence: 0.8, citedEvidenceIds: ['ev-1'] }) } }],
      }),
    };
  };
  const result = await runContextWorker(
    { query: 'what should ship next', text: '[ev-1] key=goal: ship the swarm worker fix', evidence: [{ id: 'ev-1' }] },
    { apiKey: 'test-key', fetch: fetchStub },
  );
  assert.equal(result.status, 'answered');
  assert.equal(result.answer, 'Ship the swarm worker fix.');
  assert.equal(result.confidence, 0.8);
  assert.deepEqual(result.citedEvidenceIds, ['ev-1']);
  assert.equal(calls.length, 1);
});

test('does not fabricate an answer when there is no retrieved evidence -- says so honestly', async () => {
  const fetchStub = async () => { throw new Error('must not call the model with empty evidence'); };
  const result = await runContextWorker({ query: 'q', text: '', evidence: [] }, { apiKey: 'test-key', fetch: fetchStub });
  assert.equal(result.status, 'no_evidence');
  assert.match(result.answer, /no retained private context/i);
});

test('throws (does not silently fabricate) when the model call fails', async () => {
  const fetchStub = async () => ({ ok: false, status: 500, json: async () => ({}) });
  await assert.rejects(() => runContextWorker({ query: 'q', text: 'x', evidence: [{ id: 'e' }] }, { apiKey: 'test-key', fetch: fetchStub }));
});

test('throws when no API key is configured -- never falls back to a fake answer', async () => {
  await assert.rejects(() => runContextWorker({ query: 'q', text: 'x', evidence: [{ id: 'e' }] }, { apiKey: undefined, fetch: async () => ({ ok: true, json: async () => ({}) }) }));
});
