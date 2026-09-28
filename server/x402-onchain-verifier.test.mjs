import test from 'node:test';
import assert from 'node:assert/strict';
import { createDirectTransferFacilitator, USDG_ADDRESS } from './x402-onchain-verifier.mjs';

const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const payer = '0x1111111111111111111111111111111111111111';
const payTo = '0x2222222222222222222222222222222222222222';
const txHash = `0x${'ab'.repeat(32)}`;

function pad32(addr) { return `0x${'0'.repeat(24)}${addr.slice(2)}`; }
function transferLog({ from = payer, to = payTo, value = 1_000_000n, address = USDG_ADDRESS } = {}) {
  return { address, topics: [TRANSFER_TOPIC, pad32(from), pad32(to)], data: `0x${value.toString(16)}` };
}

const requirement = { x402Version: 2, accepts: [{ scheme: 'exact', network: 'eip155:4663', asset: USDG_ADDRESS, amount: '1000000', payTo, maxTimeoutSeconds: 300 }] };

test('verifyTransaction rejects a malformed tx hash without any RPC call', async () => {
  let called = false;
  const facilitator = createDirectTransferFacilitator({ publicClient: { getTransactionReceipt: async () => { called = true; } } });
  const result = await facilitator.verifyTransaction('not-a-hash', requirement);
  assert.deepEqual(result, { status: 'invalid', reason: 'malformed_tx_hash' });
  assert.equal(called, false);
});

test('verifyTransaction verifies a real successful transfer matching amount/payTo/asset', async () => {
  const facilitator = createDirectTransferFacilitator({
    publicClient: { getTransactionReceipt: async () => ({ status: 'success', logs: [transferLog()] }) },
  });
  const result = await facilitator.verifyTransaction(txHash, requirement);
  assert.deepEqual(result, { status: 'verified', payer, txHash, amount: '1000000' });
});

test('verifyTransaction accepts an overpayment (value >= required amount)', async () => {
  const facilitator = createDirectTransferFacilitator({
    publicClient: { getTransactionReceipt: async () => ({ status: 'success', logs: [transferLog({ value: 2_000_000n })] }) },
  });
  const result = await facilitator.verifyTransaction(txHash, requirement);
  assert.equal(result.status, 'verified');
  assert.equal(result.amount, '2000000');
});

test('verifyTransaction rejects an underpayment', async () => {
  const facilitator = createDirectTransferFacilitator({
    publicClient: { getTransactionReceipt: async () => ({ status: 'success', logs: [transferLog({ value: 500_000n })] }) },
  });
  const result = await facilitator.verifyTransaction(txHash, requirement);
  assert.deepEqual(result, { status: 'invalid', reason: 'no_matching_transfer_log' });
});

test('verifyTransaction rejects a transfer to the wrong recipient', async () => {
  const facilitator = createDirectTransferFacilitator({
    publicClient: { getTransactionReceipt: async () => ({ status: 'success', logs: [transferLog({ to: '0x0000000000000000000000000000000000000009' })] }) },
  });
  const result = await facilitator.verifyTransaction(txHash, requirement);
  assert.deepEqual(result, { status: 'invalid', reason: 'no_matching_transfer_log' });
});

test('verifyTransaction rejects a transfer of the wrong asset (ignores unrelated token logs)', async () => {
  const facilitator = createDirectTransferFacilitator({
    publicClient: { getTransactionReceipt: async () => ({ status: 'success', logs: [transferLog({ address: '0x0000000000000000000000000000000000000099' })] }) },
  });
  const result = await facilitator.verifyTransaction(txHash, requirement);
  assert.deepEqual(result, { status: 'invalid', reason: 'no_matching_transfer_log' });
});

test('verifyTransaction rejects a reverted transaction', async () => {
  const facilitator = createDirectTransferFacilitator({
    publicClient: { getTransactionReceipt: async () => ({ status: 'reverted', logs: [transferLog()] }) },
  });
  const result = await facilitator.verifyTransaction(txHash, requirement);
  assert.deepEqual(result, { status: 'invalid', reason: 'transaction_failed' });
});

test('verifyTransaction reports transaction_not_found for an unknown tx, never fakes success', async () => {
  const facilitator = createDirectTransferFacilitator({
    publicClient: { getTransactionReceipt: async () => { throw new Error('not found'); } },
  });
  const result = await facilitator.verifyTransaction(txHash, requirement);
  assert.deepEqual(result, { status: 'invalid', reason: 'transaction_not_found' });
});

test('never invents a payer or signs/submits anything — module exposes only a read verifier', async () => {
  const facilitator = createDirectTransferFacilitator({
    publicClient: { getTransactionReceipt: async () => ({ status: 'success', logs: [transferLog()] }) },
  });
  assert.equal(typeof facilitator.verifyTransaction, 'function');
  assert.equal('sign' in facilitator, false);
  assert.equal('submit' in facilitator, false);
  assert.equal('privateKey' in facilitator, false);
});
