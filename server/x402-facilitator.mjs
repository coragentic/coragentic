import { readFileSync } from 'node:fs';
import { createPublicClient, http, isAddress, verifyTypedData, isHex, getAddress } from 'viem';

// USDG on Robinhood Chain (eip155:4663) implements EIP-3009 transferWithAuthorization/
// authorizationState and EIP-2612 nonces(). Confirmed live via RPC: authorizationState(),
// nonces(), balanceOf() all decode successfully while an unrelated 4-byte selector
// (0xdeadbeef) reverts on this same contract — the functions genuinely exist on-chain.
// The ABI below is the standard EIP-3009 interface (fixed signature by spec, not vendor
// guesswork), scoped to only the functions this facilitator actually calls.
const USDG_ABI = JSON.parse(readFileSync(new URL('./abi/usdg-eip3009.json', import.meta.url), 'utf8'));

export const CHAIN_ID = 4663;
export const USDG_ADDRESS = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';
export { USDG_ABI };

const EIP3009_DOMAIN_NAME = 'Global Dollar';
const EIP3009_DOMAIN_VERSION = '1';

const TRANSFER_WITH_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
};

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function isPositiveBigIntString(value) {
  return typeof value === 'string' && /^[1-9][0-9]*$/.test(value);
}

/**
 * Validate the *shape* of an EIP-3009 authorization payload before any network call.
 * This is a pure function so it is trivially unit-testable without an RPC.
 */
export function validateAuthorizationPayload(payload) {
  if (!isObject(payload)) return { ok: false, reason: 'malformed_authorization' };
  const { from, to, value, validAfter, validBefore, nonce, signature } = payload;
  if (!isAddress(from) || !isAddress(to)) return { ok: false, reason: 'malformed_authorization' };
  if (!isPositiveBigIntString(value)) return { ok: false, reason: 'malformed_authorization' };
  if (!Number.isFinite(validAfter) || !Number.isFinite(validBefore) || validBefore <= validAfter) {
    return { ok: false, reason: 'malformed_authorization' };
  }
  if (!isHex(nonce) || nonce.length !== 66) return { ok: false, reason: 'malformed_authorization' };
  if (!isHex(signature) || signature.length !== 132) return { ok: false, reason: 'malformed_authorization' };
  return { ok: true };
}

/**
 * Create a facilitator bound to USDG on Robinhood Chain. `publicClient` is injected so
 * tests can supply a fake RPC without a live network. `now()` is injected for deterministic
 * time-window tests.
 */
export function createUsdgFacilitator({
  publicClient = createPublicClient({
    chain: { id: CHAIN_ID },
    transport: http(process.env.ROBINHOOD_RPC_URL || 'https://robinhood-rpc.publicnode.com', {
      fetchOptions: { headers: { 'user-agent': 'coragentic-x402-facilitator/1.0' } },
    }),
  }),
  now = () => Math.floor(Date.now() / 1000),
} = {}) {
  return {
    /**
     * Verify an EIP-3009 transferWithAuthorization payment against an x402 payment
     * requirement. Performs, in order: shape validation, requirement/asset/amount/payTo
     * match, time-window check, EIP-712 signature recovery against the real USDG domain,
     * and an on-chain authorizationState() read to reject an already-used nonce.
     * Never submits a transaction — this is read-only verification only.
     */
    async verify(authorization, requirement) {
      const shape = validateAuthorizationPayload(authorization);
      if (!shape.ok) return { status: 'invalid', reason: shape.reason };

      const accept = Array.isArray(requirement?.accepts)
        ? requirement.accepts.find((entry) => entry?.network === 'eip155:4663' && entry?.scheme === 'exact')
        : null;
      if (!accept) return { status: 'invalid', reason: 'no_matching_requirement' };
      if (getAddress(accept.asset) !== USDG_ADDRESS) return { status: 'invalid', reason: 'unsupported_asset' };
      if (getAddress(authorization.to) !== getAddress(accept.payTo)) return { status: 'invalid', reason: 'payto_mismatch' };
      if (BigInt(authorization.value) < BigInt(accept.amount)) return { status: 'invalid', reason: 'insufficient_amount' };

      const nowTs = now();
      if (nowTs < authorization.validAfter) return { status: 'invalid', reason: 'not_yet_valid' };
      if (nowTs >= authorization.validBefore) return { status: 'invalid', reason: 'authorization_expired' };

      let signatureValid;
      try {
        signatureValid = await verifyTypedData({
          address: authorization.from,
          domain: { name: EIP3009_DOMAIN_NAME, version: EIP3009_DOMAIN_VERSION, chainId: CHAIN_ID, verifyingContract: USDG_ADDRESS },
          types: TRANSFER_WITH_AUTHORIZATION_TYPES,
          primaryType: 'TransferWithAuthorization',
          message: {
            from: authorization.from,
            to: authorization.to,
            value: BigInt(authorization.value),
            validAfter: BigInt(authorization.validAfter),
            validBefore: BigInt(authorization.validBefore),
            nonce: authorization.nonce,
          },
          signature: authorization.signature,
        });
      } catch {
        signatureValid = false;
      }
      if (!signatureValid) return { status: 'invalid', reason: 'bad_signature' };

      let used;
      try {
        used = await publicClient.readContract({
          address: USDG_ADDRESS, abi: USDG_ABI, functionName: 'authorizationState', args: [authorization.from, authorization.nonce],
        });
      } catch {
        return { status: 'unavailable', reason: 'rpc_unavailable' };
      }
      if (used) return { status: 'invalid', reason: 'nonce_already_used' };

      return { status: 'verified', payer: authorization.from };
    },
  };
}

/**
 * Build the raw calldata for submitting a verified authorization on-chain. This never
 * signs or broadcasts: it returns unsigned calldata for a relayer (or the payer's own
 * wallet) to submit. Settlement submission itself requires an operator-configured relayer
 * with its own gas wallet, wired in server composition code, never inside this module.
 */
export function buildSettlementCallData(authorization) {
  const shape = validateAuthorizationPayload(authorization);
  if (!shape.ok) throw new TypeError(shape.reason);
  const sig = authorization.signature;
  const r = `0x${sig.slice(2, 66)}`;
  const s = `0x${sig.slice(66, 130)}`;
  const v = parseInt(sig.slice(130, 132), 16);
  return { to: USDG_ADDRESS, abi: USDG_ABI, functionName: 'transferWithAuthorization', args: [
    authorization.from, authorization.to, BigInt(authorization.value),
    BigInt(authorization.validAfter), BigInt(authorization.validBefore), authorization.nonce, v, r, s,
  ] };
}
