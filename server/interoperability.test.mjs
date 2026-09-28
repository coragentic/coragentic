import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAgentCard,
  buildMcpManifest,
  canonicalJson,
  validateAgentCard,
} from './interoperability.mjs';

const row = {
  id: 'agent-1',
  name: 'Research Agent',
  description: 'Finds and summarizes public information.',
  image: 'https://example.test/agent.png',
  owner_wallet: '0x0000000000000000000000000000000000000001',
  services_json: JSON.stringify([
    { type: 'A2A', endpoint: 'https://example.test/a2a' },
    { type: 'MCP', endpoint: 'https://example.test/mcp' },
  ]),
  capabilities_json: JSON.stringify(['search', 'summarize']),
  supported_trust_json: JSON.stringify(['reputation'] ),
  x402_support: 1,
  status: 'active',
};

test('builds a deterministic A2A card from an agent row without claiming registration', () => {
  const card = buildAgentCard(row, { baseUrl: 'https://example.test' });
  assert.equal(card.protocolVersion, '0.3.0');
  assert.equal(card.name, row.name);
  assert.equal(card.url, 'https://example.test/a2a/agents/agent-1');
  assert.deepEqual(card.skills.map(({ id }) => id), ['search', 'summarize']);
  assert.deepEqual(card.authentication, { schemes: ['bearer'] });
  assert.equal(card.metadata.chain.namespace, 'eip155');
  assert.equal(card.metadata.chain.chainId, '4663');
  assert.equal(card.metadata.verification.status, 'unverified');
  assert.equal(card.metadata.verification.onchain, false);
  assert.equal(card.metadata.verification.claims, undefined);
  assert.equal(validateAgentCard(card).valid, true);
});

test('canonical JSON is stable for equivalent cards', () => {
  const first = buildAgentCard(row, { baseUrl: 'https://example.test' });
  const second = buildAgentCard({ ...row, capabilities_json: JSON.stringify(['summarize', 'search']) }, { baseUrl: 'https://example.test' });
  assert.equal(canonicalJson(first), canonicalJson(second));
});

test('rejects fake on-chain claims and malformed cards', () => {
  const card = buildAgentCard(row);
  assert.equal(validateAgentCard({ ...card, metadata: { ...card.metadata, onchain: true } }).valid, false);
  assert.equal(validateAgentCard({ ...card, name: '' }).valid, false);
});

test('builds the deterministic MCP discovery manifest for all Coragentic tools', () => {
  const manifest = buildMcpManifest({ baseUrl: 'https://example.test' });
  assert.equal(manifest.name, 'coragentic');
  assert.deepEqual(manifest.tools.map(({ name }) => name), [
    'memory', 'offerings', 'jobs', 'audit', 'market',
  ]);
  assert.equal(manifest.metadata.verification.status, 'unverified');
  assert.equal(manifest.metadata.chain.chainId, '4663');
  assert.equal(canonicalJson(manifest), canonicalJson(buildMcpManifest({ baseUrl: 'https://example.test/' })));
});
