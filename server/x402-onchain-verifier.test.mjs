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

// Every mocked receipt below now carries a blockNumber, and every mocked client
// supplies getChainId()/getBlockNumber() so the confirmation-depth and chain-id
// checks added below have realistic inputs to work with.
function client({ receipt, blockNumber = 1_000n, chainId = 4663 } = {}) {
  return {
    getTransactionReceipt: async () => receipt,
    getBlockNumber: async () => blockNumber,
    getChainId: async () => chainId,
  };
}

test('verifyTransaction rejects a malformed tx hash without any RPC call', async () => {
  let called = false;
  const facilitator = createDirectTransferFacilitator({ publicClient: { getTransactionReceipt: async () => { called = true; } } });
  const result = await facilitator.verifyTransaction('not-a-hash', requirement);
  assert.deepEqual(result, { status: 'invalid', reason: 'malformed_tx_hash' });
  assert.equal(called, false);
});

test('verifyTransaction verifies a real successful transfer matching amount/payTo/asset, with sufficient confirmations', async () => {
  const facilitator = createDirectTransferFacilitator({
    publicClient: client({ receipt: { status: 'success', logs: [transferLog()], blockNumber: 995n }, blockNumber: 1_000n }),
  });
  const result = await facilitator.verifyTransaction(txHash, requirement);
  assert.deepEqual(result, { status: 'verified', payer, txHash, amount: '1000000', confirmations: 6 });
});

test('verifyTransaction accepts an overpayment (value >= required amount)', async () => {
  const facilitator = createDirectTransferFacilitator({
    publicClient: client({ receipt: { status: 'success', logs: [transferLog({ value: 2_000_000n })], blockNumber: 995n }, blockNumber: 1_000n }),
  });
  const result = await facilitator.verifyTransaction(txHash, requirement);
  assert.equal(result.status, 'verified');
  assert.equal(result.amount, '2000000');
});

test('verifyTransaction rejects an underpayment', async () => {
  const facilitator = createDirectTransferFacilitator({
    publicClient: client({ receipt: { status: 'success', logs: [transferLog({ value: 500_000n })], blockNumber: 995n }, blockNumber: 1_000n }),
  });
  const result = await facilitator.verifyTransaction(txHash, requirement);
  assert.deepEqual(result, { status: 'invalid', reason: 'no_matching_transfer_log' });
});

test('verifyTransaction rejects a transfer to the wrong recipient', async () => {
  const facilitator = createDirectTransferFacilitator({
    publicClient: client({ receipt: { status: 'success', logs: [transferLog({ to: '0x0000000000000000000000000000000000000009' })], blockNumber: 995n }, blockNumber: 1_000n }),
  });
  const result = await facilitator.verifyTransaction(txHash, requirement);
  assert.deepEqual(result, { status: 'invalid', reason: 'no_matching_transfer_log' });
});

test('verifyTransaction rejects a transfer of the wrong asset (ignores unrelated token logs)', async () => {
  const facilitator = createDirectTransferFacilitator({
    publicClient: client({ receipt: { status: 'success', logs: [transferLog({ address: '0x0000000000000000000000000000000000000099' })], blockNumber: 995n }, blockNumber: 1_000n }),
  });
  const result = await facilitator.verifyTransaction(txHash, requirement);
  assert.deepEqual(result, { status: 'invalid', reason: 'no_matching_transfer_log' });
});

test('verifyTransaction rejects a reverted transaction', async () => {
  const facilitator = createDirectTransferFacilitator({
    publicClient: client({ receipt: { status: 'reverted', logs: [transferLog()], blockNumber: 995n }, blockNumber: 1_000n }),
  });
  const result = await facilitator.verifyTransaction(txHash, requirement);
  assert.deepEqual(result, { status: 'invalid', reason: 'transaction_failed' });
});

test('verifyTransaction reports transaction_not_found for an unknown tx, never fakes success', async () => {
  const facilitator = createDirectTransferFacilitator({
    publicClient: { getTransactionReceipt: async () => { throw new Error('not found'); }, getBlockNumber: async () => 1_000n, getChainId: async () => 4663 },
  });
  const result = await facilitator.verifyTransaction(txHash, requirement);
  assert.deepEqual(result, { status: 'invalid', reason: 'transaction_not_found' });
});

test('never invents a payer or signs/submits anything — module exposes only a read verifier', async () => {
  const facilitator = createDirectTransferFacilitator({
    publicClient: client({ receipt: { status: 'success', logs: [transferLog()], blockNumber: 995n }, blockNumber: 1_000n }),
  });
  assert.equal(typeof facilitator.verifyTransaction, 'function');
  assert.equal('sign' in facilitator, false);
  assert.equal('submit' in facilitator, false);
  assert.equal('privateKey' in facilitator, false);
});

test('verifyTransaction rejects a transaction with fewer than the required confirmations (reorg risk window)', async () => {
  const facilitator = createDirectTransferFacilitator({
    // Receipt is in block 999, current tip is 1000 -- only 1 confirmation, below
    // the default minimum. A block this fresh could still be reorged out.
    publicClient: client({ receipt: { status: 'success', logs: [transferLog()], blockNumber: 999n }, blockNumber: 1_000n }),
  });
  const result = await facilitator.verifyTransaction(txHash, requirement);
  assert.deepEqual(result, { status: 'unavailable', reason: 'insufficient_confirmations' });
});

test('verifyTransaction accepts a custom confirmations requirement', async () => {
  const facilitator = createDirectTransferFacilitator({
    publicClient: client({ receipt: { status: 'success', logs: [transferLog()], blockNumber: 999n }, blockNumber: 1_000n }),
    confirmations: 2,
  });
  const result = await facilitator.verifyTransaction(txHash, requirement);
  assert.equal(result.status, 'verified');
  assert.equal(result.confirmations, 2);
});

test('verifyTransaction refuses to verify against an RPC reporting the wrong chain id', async () => {
  const facilitator = createDirectTransferFacilitator({
    publicClient: client({ receipt: { status: 'success', logs: [transferLog()], blockNumber: 995n }, blockNumber: 1_000n, chainId: 1 }),
  });
  const result = await facilitator.verifyTransaction(txHash, requirement);
  assert.deepEqual(result, { status: 'unavailable', reason: 'rpc_chain_id_mismatch' });
});
