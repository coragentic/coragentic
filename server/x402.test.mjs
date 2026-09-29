import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FACILITATOR_BLOCKER,
  NETWORK,
  createPaymentRequired,
  parsePaymentSignature,
  createX402Boundary,
  createReplayGuard,
} from './x402.mjs';

const encoded = (value) => Buffer.from(JSON.stringify(value)).toString('base64');
const requirement = createPaymentRequired({
  amount: '1000000',
  asset: '0x0000000000000000000000000000000000000001',
  payTo: '0x0000000000000000000000000000000000000002',
  resource: 'https://example.test/v1/jobs/job-1',
});
const payment = { x402Version: 2, scheme: 'exact', network: NETWORK, payload: { nonce: 'n-1', expiresAt: 9_999_999_999_999, authorization: '0xsig' } };

test('creates a strict eip155:4663 payment requirement', () => {
  assert.equal(requirement.x402Version, 2);
  assert.deepEqual(requirement.accepts[0], {
    scheme: 'exact', network: NETWORK, asset: '0x0000000000000000000000000000000000000001',
    amount: '1000000', payTo: '0x0000000000000000000000000000000000000002',
    maxTimeoutSeconds: 300, resource: 'https://example.test/v1/jobs/job-1',
  });
});

test('safely rejects malformed signatures and wrong networks', () => {
  assert.equal(parsePaymentSignature('not-json').ok, false);
  assert.equal(parsePaymentSignature(encoded({ ...payment, network: 'eip155:1' })).error, 'network_mismatch');
  assert.equal(parsePaymentSignature(encoded(payment)).ok, true);
});

test('returns unavailable when the injected verifier is unavailable', async () => {
  const boundary = createX402Boundary({ verify: async () => { throw new Error('facilitator offline'); } });
  assert.deepEqual(await boundary.verifyPayment(encoded(payment), requirement), { status: 'unavailable', reason: 'facilitator_unavailable' });
});

test('returns invalid for verifier rejection and verified for injected success', async () => {
  const invalid = createX402Boundary({ verify: async () => ({ valid: false, reason: 'bad_signature' }) });
  assert.deepEqual(await invalid.verifyPayment(encoded(payment), requirement), { status: 'invalid', reason: 'bad_signature' });

  let received;
  const boundary = createX402Boundary({
    verify: async (parsed, required) => { received = [parsed, required]; return { valid: true, payer: '0xpayer' }; },
    settle: async (parsed, idempotencyKey) => ({ txHash: `0x${idempotencyKey}`, parsed }),
  });
  assert.deepEqual(await boundary.verifyPayment(encoded(payment), requirement), { status: 'verified', payer: '0xpayer' });
  assert.equal(received[0].network, NETWORK);
  await assert.rejects(() => boundary.settlePayment(payment), /idempotency key required/);
  assert.equal((await boundary.settlePayment(payment, 'idem-1')).txHash, '0xidem-1');
});

test('replay helper rejects reused nonce and expired payments', () => {
  const replay = createReplayGuard({ now: () => 1_000 });
  assert.deepEqual(replay.checkAndUse({ nonce: 'n-1', expiresAt: 2_000 }), { ok: true });
  assert.deepEqual(replay.checkAndUse({ nonce: 'n-1', expiresAt: 2_000 }), { ok: false, reason: 'nonce_replayed' });
  assert.deepEqual(replay.checkAndUse({ nonce: 'n-2', expiresAt: 999 }), { ok: false, reason: 'payment_expired' });
});

test('documents that settlement is blocked until a real facilitator exists', () => {
  assert.match(FACILITATOR_BLOCKER, /facilitator/i);
  assert.match(FACILITATOR_BLOCKER, /no fake settlement/i);
});

test('an attacker cannot poison a legitimate nonce by submitting a malformed authorization under it first', async () => {
  // The replay guard must not consume/mark a nonce as used until the
  // underlying authorization actually verifies. Otherwise an attacker who
  // merely knows a legitimate wrapper nonce (e.g. observed in a prior request)
  // can submit garbage under that same nonce and get the real payment
  // rejected with nonce_replayed for the rest of the process lifetime --
  // a denial-of-service on someone else's valid payment.
  let verifyCalls = 0;
  const boundary = createX402Boundary({
    verify: async (parsed) => {
      verifyCalls += 1;
      // Simulate: the first submission under this nonce is bad crypto (attacker
      // noise); the second submission under the SAME nonce is the real payer's
      // legitimate authorization and must still be able to succeed.
      if (verifyCalls === 1) return { valid: false, reason: 'bad_signature' };
      return { valid: true, payer: '0xpayer' };
    },
  });
  const attackerAttempt = await boundary.verifyPayment(encoded(payment), requirement);
  assert.equal(attackerAttempt.status, 'invalid');
  assert.equal(attackerAttempt.reason, 'bad_signature');

  const legitimateAttempt = await boundary.verifyPayment(encoded(payment), requirement);
  assert.equal(legitimateAttempt.status, 'verified');
  assert.equal(legitimateAttempt.payer, '0xpayer');
});
