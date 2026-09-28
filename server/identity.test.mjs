import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CHAIN_ID,
  IDENTITY_REGISTRY_ADDRESS,
  createRegistrationPayload,
  hashRegistrationPayload,
  buildRegisterCall,
  verifyRegistration,
} from './identity.mjs';

test('registration payload and hash are deterministic across key order', () => {
  const first = createRegistrationPayload({
    name: 'Coragentic',
    services: [{ type: 'A2A', endpoint: 'https://example.test' }],
    owner: '0x0000000000000000000000000000000000000001',
  });
  const second = createRegistrationPayload({
    owner: '0x0000000000000000000000000000000000000001',
    services: [{ endpoint: 'https://example.test', type: 'A2A' }],
    name: 'Coragentic',
  });

  assert.deepEqual(first, second);
  assert.equal(hashRegistrationPayload(first), hashRegistrationPayload(second));
  assert.match(hashRegistrationPayload(first), /^0x[0-9a-f]{64}$/);
});

test('register call is unsupported when explicitly given ABI metadata lacking register()', () => {
  assert.deepEqual(buildRegisterCall({ payload: { name: 'draft' }, abiMetadata: { verified: false, abi: null } }), {
    supported: false,
    reason: 'verified_abi_required',
  });
});

test('register call is supported by default using the vendored verified ERC-8004 ABI', () => {
  const result = buildRegisterCall({ payload: { name: 'draft' } });
  assert.equal(result.supported, true);
  assert.equal(result.to, IDENTITY_REGISTRY_ADDRESS);
  assert.equal(result.functionName, 'register');
});

test('register call is encoded only from verified ABI metadata', () => {
  const abiMetadata = {
    verified: true,
    abi: [{
      type: 'function', name: 'register', stateMutability: 'nonpayable',
      inputs: [{ name: 'agentURI', type: 'string' }], outputs: [{ name: 'agentId', type: 'uint256' }],
    }],
  };
  const result = buildRegisterCall({
    registryAddress: IDENTITY_REGISTRY_ADDRESS,
    abiMetadata,
    payload: { name: 'Coragentic' },
  });

  assert.equal(result.supported, true);
  assert.equal(result.to, IDENTITY_REGISTRY_ADDRESS);
  assert.equal(result.functionName, 'register');
  assert.equal(result.args.length, 1);
  assert.match(result.data, /^0x[0-9a-f]+$/);
});

test('registration verification uses only the injected provider', async () => {
  const calls = [];
  const provider = {
    readContract: async (request) => {
      calls.push(request);
      return 'ipfs://registration';
    },
  };
  const result = await verifyRegistration(provider, {
    registryAddress: IDENTITY_REGISTRY_ADDRESS,
    agentId: 7n,
    expectedAgentURI: 'ipfs://registration',
    abiMetadata: {
      verified: true,
      abi: [{
        type: 'function', name: 'tokenURI', stateMutability: 'view',
        inputs: [{ name: 'tokenId', type: 'uint256' }], outputs: [{ name: '', type: 'string' }],
      }],
    },
  });

  assert.deepEqual(result, { verified: true, onchain: true, agentId: '7', agentURI: 'ipfs://registration', chainId: CHAIN_ID });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].address, IDENTITY_REGISTRY_ADDRESS);
});

test('registration verification reports unsupported without a provider', async () => {
  await assert.rejects(
    verifyRegistration(null, { agentId: 1n }),
    (error) => error.code === 'provider_required',
  );
});
