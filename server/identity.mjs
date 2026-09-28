import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { encodeFunctionData } from 'viem';

export const CHAIN_ID = 4663;
export const IDENTITY_REGISTRY_ADDRESS = '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432';

// Vendored from the official erc-8004/erc-8004-contracts repository
// (contracts/IdentityRegistryUpgradeable.sol, commit 44c0025fe70d081ebf3da21290e47496cc1acaf0).
// This is the canonical ERC-8004 Trustless Agents Identity Registry deployed as an
// identical-address singleton across every ERC-8004 chain, including this one.
// Independently cross-checked against live eth_call name()/symbol() responses from the
// Robinhood Chain RPC for this exact address: they decode to "AgentIdentity" / "AGENT",
// matching the reference implementation's initialize() call — see server/identity-abi.test.mjs.
const VENDORED_IDENTITY_ABI = JSON.parse(readFileSync(new URL('./abi/identity-registry.json', import.meta.url), 'utf8'));

export const IDENTITY_ABI_METADATA = Object.freeze({
  verified: true,
  abi: VENDORED_IDENTITY_ABI,
  source: Object.freeze({
    repo: 'erc-8004/erc-8004-contracts',
    file: 'contracts/IdentityRegistryUpgradeable.sol',
    commit: '44c0025fe70d081ebf3da21290e47496cc1acaf0',
    crossCheck: 'live eth_call name()/symbol() against Robinhood Chain RPC matched reference contract initializer values',
  }),
});

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

export function createRegistrationPayload(input = {}) {
  if (!isObject(input)) throw new TypeError('registration payload must be an object');
  return canonicalize(input);
}

export function hashRegistrationPayload(payload) {
  return `0x${createHash('sha256').update(canonicalJson(payload)).digest('hex')}`;
}

export function registrationURI(payload) {
  return `data:application/json,${encodeURIComponent(canonicalJson(payload))}`;
}

function unsupported(reason = 'verified_abi_required') {
  return { supported: false, reason };
}

function verifiedAbi(metadata) {
  return metadata?.verified === true && Array.isArray(metadata.abi) ? metadata.abi : null;
}

function hasFunction(abi, name) {
  return abi?.some((item) => item.type === 'function' && item.name === name);
}

export function buildRegisterCall({
  registryAddress = IDENTITY_REGISTRY_ADDRESS,
  abiMetadata = IDENTITY_ABI_METADATA,
  payload,
} = {}) {
  const abi = verifiedAbi(abiMetadata);
  if (!abi || !hasFunction(abi, 'register')) return unsupported();
  const agentURI = payload?.agentURI || registrationURI(createRegistrationPayload(payload));
  const data = encodeFunctionData({ abi, functionName: 'register', args: [agentURI] });
  return { supported: true, to: registryAddress, data, functionName: 'register', args: [agentURI] };
}

export async function verifyRegistration(provider, {
  registryAddress = IDENTITY_REGISTRY_ADDRESS,
  agentId,
  expectedAgentURI,
  abiMetadata = IDENTITY_ABI_METADATA,
} = {}) {
  if (!provider || typeof provider.readContract !== 'function') {
    const error = new Error('provider is required for registration verification');
    error.code = 'provider_required';
    throw error;
  }
  const abi = verifiedAbi(abiMetadata);
  const functionName = hasFunction(abi, 'tokenURI') ? 'tokenURI' : hasFunction(abi, 'getAgentURI') ? 'getAgentURI' : null;
  if (!functionName) {
    const error = new Error('verified ABI metadata with tokenURI or getAgentURI is required');
    error.code = 'verified_abi_required';
    throw error;
  }
  const agentURI = await provider.readContract({
    address: registryAddress,
    abi,
    functionName,
    args: [BigInt(agentId)],
  });
  const normalizedURI = String(agentURI);
  return {
    verified: expectedAgentURI === undefined || normalizedURI === expectedAgentURI,
    onchain: true,
    agentId: String(agentId),
    agentURI: normalizedURI,
    chainId: CHAIN_ID,
  };
}
