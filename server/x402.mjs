import { isAddress } from 'viem';

export const NETWORK = 'eip155:4663';
export const FACILITATOR_BLOCKER =
  'Settlement is blocked: no production x402 facilitator is configured for eip155:4663; no fake settlement is performed.';

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonEmpty = (value) => typeof value === 'string' && value.length > 0;

export function createPaymentRequired({
  amount,
  asset,
  payTo,
  resource,
  description,
  maxTimeoutSeconds = 300,
} = {}) {
  if (!nonEmpty(amount) || !/^\d+$/.test(amount) || BigInt(amount) <= 0n) throw new TypeError('amount must be a positive atomic integer string');
  if (!nonEmpty(asset) || !nonEmpty(payTo)) throw new TypeError('asset and payTo are required');
  const nativeAsset = asset.toLowerCase() === '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
  if (!nativeAsset && !isAddress(asset)) throw new TypeError('asset must be an EVM address or native asset sentinel');
  if (!isAddress(payTo) || /^0x0{40}$/i.test(payTo)) throw new TypeError('payTo must be a non-zero EVM address');
  if (!Number.isInteger(maxTimeoutSeconds) || maxTimeoutSeconds <= 0) throw new TypeError('maxTimeoutSeconds must be positive');
  const accept = { scheme: 'exact', network: NETWORK, asset, amount, payTo, maxTimeoutSeconds };
  if (resource !== undefined) {
    if (!nonEmpty(resource)) throw new TypeError('resource must be a non-empty string');
    accept.resource = resource;
  }
  if (description !== undefined) {
    if (!nonEmpty(description)) throw new TypeError('description must be a non-empty string');
    accept.description = description;
  }
  return { x402Version: 2, accepts: [accept] };
}

function decodeSignature(value) {
  if (!nonEmpty(value)) throw new Error('signature_required');
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  return JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
}

export function parsePaymentSignature(signature) {
  try {
    const payment = decodeSignature(signature);
    if (!isObject(payment) || payment.x402Version !== 2 || payment.scheme !== 'exact' || !isObject(payment.payload)) {
      return { ok: false, error: 'malformed_signature' };
    }
    if (payment.network !== NETWORK) return { ok: false, error: 'network_mismatch' };
    if (!nonEmpty(payment.payload.nonce) || !Number.isFinite(payment.payload.expiresAt)) {
      return { ok: false, error: 'malformed_signature' };
    }
    return { ok: true, value: payment };
  } catch {
    return { ok: false, error: 'malformed_signature' };
  }
}

export const safeParseSignature = parsePaymentSignature;

export function createReplayGuard({ now = () => Date.now() } = {}) {
  const used = new Set();
  return {
    check({ nonce, expiresAt } = {}) {
      if (!nonEmpty(nonce) || !Number.isFinite(expiresAt)) return { ok: false, reason: 'malformed_payment' };
      if (expiresAt <= now()) return { ok: false, reason: 'payment_expired' };
      if (used.has(nonce)) return { ok: false, reason: 'nonce_replayed' };
      return { ok: true };
    },
    use({ nonce } = {}) {
      if (nonEmpty(nonce)) used.add(nonce);
    },
    checkAndUse(payload) {
      const result = this.check(payload);
      if (!result.ok) return result;
      this.use(payload);
      return { ok: true };
    },
  };
}

export function createX402Boundary({ verify, settle, replay = createReplayGuard() } = {}) {
  return {
    async verifyPayment(signature, requirement) {
      const parsed = parsePaymentSignature(signature);
      if (!parsed.ok) return { status: 'invalid', reason: parsed.error };
      if (!isObject(requirement) || requirement.x402Version !== 2 || !Array.isArray(requirement.accepts) ||
          !requirement.accepts.some((accept) => accept?.network === NETWORK && accept?.scheme === 'exact')) {
        return { status: 'invalid', reason: 'network_mismatch' };
      }
      const replayResult = replay.check(parsed.value.payload);
      if (!replayResult.ok) return { status: 'invalid', reason: replayResult.reason };
      if (typeof verify !== 'function') return { status: 'unavailable', reason: 'facilitator_unavailable' };
      try {
        const result = await verify(parsed.value, requirement);
        if (result?.unavailable || result?.status === 'unavailable') return { status: 'unavailable', reason: result.reason || 'facilitator_unavailable' };
        if (result?.status === 'invalid') return { status: 'invalid', reason: result.reason || 'payment_invalid' };
        if (result?.status === 'verified') { replay.use(parsed.value.payload); return result; }
        if (!result?.valid) return { status: 'invalid', reason: result?.reason || 'payment_invalid' };
        // Only mark the nonce consumed once verification has actually succeeded --
        // an unverified/malformed submission under a legitimate nonce must never
        // be able to burn that nonce and deny the real payer's later attempt.
        replay.use(parsed.value.payload);
        const { valid: _valid, ...details } = result;
        return { status: 'verified', ...details };
      } catch {
        return { status: 'unavailable', reason: 'facilitator_unavailable' };
      }
    },

    async settlePayment(payment, idempotencyKey) {
      if (!nonEmpty(idempotencyKey)) throw new TypeError('idempotency key required');
      if (typeof settle !== 'function') throw new Error(FACILITATOR_BLOCKER);
      return settle(payment, idempotencyKey);
    },
  };
}
