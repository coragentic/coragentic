import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CHAIN_ID,
  WETH,
  USDG,
  ROUTER,
  QUOTERV2,
  createRobinhoodPublicClient,
  quoteSwap,
  previewSwap,
  validateSwapInput,
  noCustodyMessage,
} from './rh-swap.mjs';

test('Robinhood Chain swap constants match Chronoa', () => {
  assert.equal(CHAIN_ID, 4663);
  assert.equal(WETH, '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73');
  assert.equal(USDG, '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168');
  assert.equal(ROUTER, '0xcaf681a66d020601342297493863e78c959e5cb2');
  assert.equal(QUOTERV2, '0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7');
});

test('swap input validation rejects malformed token and amount', () => {
  assert.throws(() => validateSwapInput({ token: 'not-an-address', amount: '1' }), /invalid token address/);
  assert.throws(() => validateSwapInput({ token: WETH, amount: '0' }), /invalid amount/);
  assert.throws(() => validateSwapInput({ token: WETH, amount: '1.2.3' }), /invalid amount/);
  assert.throws(() => validateSwapInput({ token: WETH, amount: 1 }), /invalid amount/);
});

test('public client creation never requires or accepts private keys', () => {
  const client = createRobinhoodPublicClient({ rpcUrl: 'http://127.0.0.1:8545' });
  assert.equal(client.chain.id, CHAIN_ID);
  assert.equal(client.account, undefined);
  assert.match(noCustodyMessage(), /does not custody private keys/i);
});

test('quote and preview fail honestly without a usable client/account', async () => {
  await assert.rejects(() => quoteSwap({ token: WETH, amount: '1' }, { client: {} }), /public client/i);
  await assert.rejects(() => previewSwap({ token: WETH, amount: '1' }), /wallet address is required/i);
});
