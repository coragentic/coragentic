import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentRuntime } from '../src/runtime.mjs';

const manifest = {
  id: 'did:example:agent',
  name: 'Test agent',
  version: '0.1.0',
  services: [{ id: 'svc', type: 'tool', tools: ['quote', 'spend'] }],
};

const policy = {
  maxAtomicPerCall: '100',
  dailyAtomic: '150',
  allowedAssets: ['USDC'],
  allowedRecipients: ['0xrecipient'],
};

function makeRuntime(audit = []) {
  return createAgentRuntime({
    manifest,
    policy,
    audit: (event) => audit.push(event),
    tools: {
      quote: {
        description: 'Returns a deterministic quote',
        inputSchema: (input) => typeof input.symbol === 'string',
        execute: async (input) => ({ symbol: input.symbol, price: '42' }),
      },
      spend: {
        inputSchema: (input) => typeof input.amountAtomic === 'string',
        execute: async (input) => ({ sent: input.amountAtomic }),
      },
    },
  });
}

test('executes an allowlisted tool and audits completion', async () => {
  const audit = [];
  const runtime = makeRuntime(audit);
  assert.deepEqual(runtime.listTools(), ['quote', 'spend']);
  assert.deepEqual(await runtime.executeTool('quote', { symbol: 'ETH' }), { symbol: 'ETH', price: '42' });
  assert.deepEqual(audit.map((event) => event.status), ['requested', 'completed']);
});

test('rejects invalid input before execution', async () => {
  const audit = [];
  const runtime = makeRuntime(audit);
  await assert.rejects(runtime.executeTool('quote', { symbol: 3 }), /input schema/);
  assert.deepEqual(audit.map((event) => event.status), ['requested', 'rejected']);
});

test('enforces spend policy and records approval/rejection', async () => {
  const audit = [];
  const runtime = makeRuntime(audit);
  await runtime.executeTool('spend', { amountAtomic: '50', asset: 'USDC', recipient: '0xrecipient' }, { request: { type: 'spend', amountAtomic: '50', asset: 'USDC', recipient: '0xrecipient' } });
  await assert.rejects(runtime.executeTool('spend', { amountAtomic: '101', asset: 'USDC', recipient: '0xrecipient' }, { request: { type: 'spend', amountAtomic: '101', asset: 'USDC', recipient: '0xrecipient' } }), /policy/);
  assert.deepEqual(audit.map((event) => event.status), ['requested', 'approved', 'completed', 'requested', 'rejected']);
});

test('times out a slow tool', async () => {
  const runtime = createAgentRuntime({
    manifest,
    tools: { quote: { execute: () => new Promise((resolve) => setTimeout(resolve, 30)), timeoutMs: 5 } },
  });
  await assert.rejects(runtime.executeTool('quote', {}), /timed out/);
});

test('delegates memory operations to an injected adapter and audits them', async () => {
  const calls = [];
  const audit = [];
  const memory = {
    retain: async (...args) => { calls.push(['retain', args]); return 'memory-1'; },
    recall: async (...args) => { calls.push(['recall', args]); return [{ id: 'memory-1' }]; },
    forget: async (...args) => { calls.push(['forget', args]); return true; },
  };
  const runtime = createAgentRuntime({ manifest, tools: {}, memory, audit: (event) => audit.push(event) });

  assert.equal(await runtime.retain({ text: 'hello' }), 'memory-1');
  assert.deepEqual(await runtime.recall({ text: 'hello' }), [{ id: 'memory-1' }]);
  assert.equal(await runtime.forget('memory-1'), true);
  assert.deepEqual(calls, [
    ['retain', [{ text: 'hello' }]],
    ['recall', [{ text: 'hello' }]],
    ['forget', ['memory-1']],
  ]);
  assert.deepEqual(audit.map(({ operation, status }) => [operation, status]), [
    ['retain', 'requested'], ['retain', 'completed'],
    ['recall', 'requested'], ['recall', 'completed'],
    ['forget', 'requested'], ['forget', 'completed'],
  ]);
});

test('audits and surfaces memory adapter failures', async () => {
  const audit = [];
  const runtime = createAgentRuntime({
    manifest,
    tools: {},
    memory: { retain: async () => { throw new Error('storage unavailable'); }, recall: async () => [], forget: async () => true },
    audit: (event) => audit.push(event),
  });
  await assert.rejects(runtime.retain({ text: 'hello' }), /storage unavailable/);
  assert.equal(audit.at(-1).operation, 'retain');
  assert.equal(audit.at(-1).status, 'failed');
  assert.equal(audit.at(-1).error, 'storage unavailable');
});

test('requires all memory adapter methods when memory is supplied', () => {
  assert.throws(() => createAgentRuntime({ manifest, tools: {}, memory: { retain: async () => {} } }), /retain, recall, and forget/);
});
