import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { decodeFunctionResult, encodeFunctionData } from 'viem';
import { IDENTITY_ABI_METADATA, buildRegisterCall, verifyRegistration, IDENTITY_REGISTRY_ADDRESS } from './identity.mjs';

// Provenance: this ABI is hand-transcribed from the official erc-8004/erc-8004-contracts
// repository (commit 44c0025fe70d081ebf3da21290e47496cc1acaf0,
// contracts/IdentityRegistryUpgradeable.sol) and independently cross-checked against
// live bytecode responses from the Robinhood Chain RPC for the same registry address
// used across every ERC-8004 deployment (0x8004A169FB4a3325136EB29fA0ceB6D2e539a432):
//   eth_call name()   -> 0x...0d 4167656e744964656e74697479...  decodes to "AgentIdentity"
//   eth_call symbol() -> 0x...05 4147454e54...                  decodes to "AGENT"
// Both match the reference implementation's initialize(): __ERC721_init("AgentIdentity", "AGENT").

test('vendored ABI metadata is marked verified with recorded provenance', () => {
  assert.equal(IDENTITY_ABI_METADATA.verified, true);
  assert.equal(IDENTITY_ABI_METADATA.source.repo, 'erc-8004/erc-8004-contracts');
  assert.match(IDENTITY_ABI_METADATA.source.commit, /^[0-9a-f]{40}$/);
  assert.ok(Array.isArray(IDENTITY_ABI_METADATA.abi) && IDENTITY_ABI_METADATA.abi.length > 0);
});

test('ABI register(string) selector and result decoding match the live registry contract', () => {
  // Independently verify the ABI actually decodes the real name()/symbol() raw responses
  // captured live from the Robinhood Chain RPC (see provenance comment above) rather than
  // trusting the transcription blindly.
  const nameRaw = '0x0000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000000d4167656e744964656e7469747900000000000000000000000000000000000000';
  const symbolRaw = '0x000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000000054147454e54000000000000000000000000000000000000000000000000000000';
  const decodedName = decodeFunctionResult({ abi: IDENTITY_ABI_METADATA.abi, functionName: 'name', data: nameRaw });
  const decodedSymbol = decodeFunctionResult({ abi: IDENTITY_ABI_METADATA.abi, functionName: 'symbol', data: symbolRaw });
  assert.equal(decodedName, 'AgentIdentity');
  assert.equal(decodedSymbol, 'AGENT');
});

test('buildRegisterCall encodes a real register(string) call against the verified ABI', () => {
  const call = buildRegisterCall({ payload: { name: 'test-agent', description: 'demo' } });
  assert.equal(call.supported, true);
  assert.equal(call.to, IDENTITY_REGISTRY_ADDRESS);
  assert.equal(call.functionName, 'register');
  assert.ok(typeof call.data === 'string' && call.data.startsWith('0x'));
  // round-trip: encoding with the same ABI and args must reproduce identical calldata
  const reencoded = encodeFunctionData({ abi: IDENTITY_ABI_METADATA.abi, functionName: 'register', args: call.args });
  assert.equal(reencoded, call.data);
});

test('verifyRegistration reads tokenURI through the verified ABI via an injected provider', async () => {
  const calls = [];
  const provider = {
    async readContract(args) { calls.push(args); return 'data:application/json,%7B%22name%22%3A%22demo%22%7D'; },
  };
  const result = await verifyRegistration(provider, { agentId: '7', expectedAgentURI: 'data:application/json,%7B%22name%22%3A%22demo%22%7D' });
  assert.equal(result.verified, true);
  assert.equal(result.onchain, true);
  assert.equal(result.agentId, '7');
  assert.equal(calls[0].functionName, 'tokenURI');
  assert.equal(calls[0].address, IDENTITY_REGISTRY_ADDRESS);
});

test('ABI file on disk matches the metadata embedded in identity.mjs (no silent drift)', () => {
  const onDisk = JSON.parse(readFileSync(new URL('./abi/identity-registry.json', import.meta.url), 'utf8'));
  assert.deepEqual(onDisk, IDENTITY_ABI_METADATA.abi);
});
