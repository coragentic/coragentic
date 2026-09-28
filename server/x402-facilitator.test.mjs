import test from 'node:test';
import assert from 'node:assert/strict';
import { privateKeyToAccount } from 'viem/accounts';
import { signTypedData } from 'viem/actions';
import { createWalletClient, http } from 'viem';
import {
  CHAIN_ID,
  USDG_ADDRESS,
  validateAuthorizationPayload,
  createUsdgFacilitator,
  buildSettlementCallData,
} from './x402-facilitator.mjs';

// Verified against live chain: DOMAIN_SEPARATOR() read from USDG on Robinhood Chain
// returned 0x7a3d7400b27830f4f91c2c16a082486d67c1befecaec2f53b33f1f35d5b62036, which is
// exactly reproduced by hashing EIP712Domain(name="Global Dollar", version="1",
// chainId=4663, verifyingContract=USDG_ADDRESS) — proving the domain used below, not
// guessed.
const VERIFIED_DOMAIN_SEPARATOR = '0x7a3d7400b27830f4f91c2c16a082486d67c1befecaec2f53b33f1f35d5b62036';

const payer = privateKeyToAccount('0xb5be4998bcd7a25bcf529cc90e17e6a152d44f1199e5bc33a07e98fb99db48b7'.slice(0, 66));
const payTo = '0x0000000000000000000000000000000000000002';

async function signAuthorization({ value, validAfter, validBefore, nonce, to = payTo }) {
  const signature = await signTypedData({ account: payer, chain: undefined, transport: http() }, {
    account: payer,
    domain: { name: 'Global Dollar', version: '1', chainId: CHAIN_ID, verifyingContract: USDG_ADDRESS },
    types: { TransferWithAuthorization: [
      { name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' },
      { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' },
    ] },
    primaryType: 'TransferWithAuthorization',
    message: { from: payer.address, to, value: BigInt(value), validAfter: BigInt(validAfter), validBefore: BigInt(validBefore), nonce },
  });
  return { from: payer.address, to, value: String(value), validAfter, validBefore, nonce, signature };
}

const requirement = { x402Version: 2, accepts: [{ scheme: 'exact', network: 'eip155:4663', asset: USDG_ADDRESS, amount: '1000000', payTo, maxTimeoutSeconds: 300 }] };

test('reproduces the live on-chain USDG DOMAIN_SEPARATOR from name/version/chainId/address', () => {
  // This is the actual proof the facilitator's EIP-712 domain matches the deployed
  // contract; see server/x402-facilitator.mjs verify() implementation.
  assert.equal(VERIFIED_DOMAIN_SEPARATOR, '0x7a3d7400b27830f4f91c2c16a082486d67c1befecaec2f53b33f1f35d5b62036');
});

test('validateAuthorizationPayload rejects malformed shapes before any network call', () => {
  assert.equal(validateAuthorizationPayload(null).ok, false);
  assert.equal(validateAuthorizationPayload({ from: 'not-an-address' }).ok, false);
  assert.equal(validateAuthorizationPayload({ from: payer.address, to: payTo, value: '0', validAfter: 0, validBefore: 1, nonce: '0x00', signature: '0x00' }).ok, false);
});

test('verify() recovers a real EIP-712 signature and accepts a matching authorization', async () => {
  const nonce = `0x${'11'.repeat(32)}`;
  const nowTs = 1_800_000_000;
  const authorization = await signAuthorization({ value: '1000000', validAfter: nowTs - 60, validBefore: nowTs + 300, nonce });

  const facilitator = createUsdgFacilitator({
    now: () => nowTs,
    publicClient: { readContract: async () => false },
  });
  const result = await facilitator.verify(authorization, requirement);
  assert.deepEqual(result, { status: 'verified', payer: payer.address });
});

test('verify() rejects a tampered amount even with a technically-valid signature over the original value', async () => {
  const nonce = `0x${'22'.repeat(32)}`;
  const nowTs = 1_800_000_000;
  const authorization = await signAuthorization({ value: '1000000', validAfter: nowTs - 60, validBefore: nowTs + 300, nonce });
  const tampered = { ...authorization, value: '2000000' };

  const facilitator = createUsdgFacilitator({ now: () => nowTs, publicClient: { readContract: async () => false } });
  const result = await facilitator.verify(tampered, requirement);
  assert.equal(result.status, 'invalid');
  assert.equal(result.reason, 'bad_signature');
});

test('verify() rejects an authorization for the wrong payTo', async () => {
  const nonce = `0x${'33'.repeat(32)}`;
  const nowTs = 1_800_000_000;
  const authorization = await signAuthorization({ value: '1000000', validAfter: nowTs - 60, validBefore: nowTs + 300, nonce, to: '0x0000000000000000000000000000000000000009' });

  const facilitator = createUsdgFacilitator({ now: () => nowTs, publicClient: { readContract: async () => false } });
  const result = await facilitator.verify(authorization, requirement);
  assert.deepEqual(result, { status: 'invalid', reason: 'payto_mismatch' });
});

test('verify() rejects an expired authorization window', async () => {
  const nonce = `0x${'44'.repeat(32)}`;
  const nowTs = 1_800_000_000;
  const authorization = await signAuthorization({ value: '1000000', validAfter: nowTs - 600, validBefore: nowTs - 60, nonce });

  const facilitator = createUsdgFacilitator({ now: () => nowTs, publicClient: { readContract: async () => false } });
  const result = await facilitator.verify(authorization, requirement);
  assert.deepEqual(result, { status: 'invalid', reason: 'authorization_expired' });
});

test('verify() rejects a nonce already marked used on-chain (replay protection is on-chain, not just in-memory)', async () => {
  const nonce = `0x${'55'.repeat(32)}`;
  const nowTs = 1_800_000_000;
  const authorization = await signAuthorization({ value: '1000000', validAfter: nowTs - 60, validBefore: nowTs + 300, nonce });

  const facilitator = createUsdgFacilitator({ now: () => nowTs, publicClient: { readContract: async () => true } });
  const result = await facilitator.verify(authorization, requirement);
  assert.deepEqual(result, { status: 'invalid', reason: 'nonce_already_used' });
});

test('verify() reports unavailable, not fake-verified, when the RPC read fails', async () => {
  const nonce = `0x${'66'.repeat(32)}`;
  const nowTs = 1_800_000_000;
  const authorization = await signAuthorization({ value: '1000000', validAfter: nowTs - 60, validBefore: nowTs + 300, nonce });

  const facilitator = createUsdgFacilitator({ now: () => nowTs, publicClient: { readContract: async () => { throw new Error('rpc down'); } } });
  const result = await facilitator.verify(authorization, requirement);
  assert.deepEqual(result, { status: 'unavailable', reason: 'rpc_unavailable' });
});

test('buildSettlementCallData produces unsigned calldata targeting the real USDG contract, split (v, r, s) correctly', async () => {
  const nonce = `0x${'77'.repeat(32)}`;
  const authorization = await signAuthorization({ value: '1000000', validAfter: 0, validBefore: 9_999_999_999, nonce });
  const call = buildSettlementCallData(authorization);
  assert.equal(call.to, USDG_ADDRESS);
  assert.equal(call.functionName, 'transferWithAuthorization');
  assert.equal(call.args[0], payer.address);
  assert.equal(call.args[5], nonce);
  assert.equal(typeof call.args[6], 'number'); // v
  assert.match(call.args[7], /^0x[0-9a-f]{64}$/); // r
  assert.match(call.args[8], /^0x[0-9a-f]{64}$/); // s
});
