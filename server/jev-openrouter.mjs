import { createDecisionAdapter } from './decision-adapter.mjs';

export const OPENROUTER_DECISIONS_URL = 'https://openrouter.ai/api/alpha/decisions';
export const DEFAULT_JEV_MODEL = 'typesafe/jev-1.13';
export const DEFAULT_JEV_TIMEOUT_MS = 1_000;
export const DEFAULT_MAX_STATE_BYTES = 64_000;

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isUnit = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
const positiveNumber = (value, fallback) => Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : fallback;
const explicitState = (input) => isObject(input) && Object.hasOwn(input, 'state') ? input.state : undefined;

function encodedState(input, maxStateBytes) {
  const state = explicitState(input);
  if (state === undefined) return null;
  try {
    const encoded = JSON.stringify(state);
    return typeof encoded === 'string' && Buffer.byteLength(encoded) <= maxStateBytes ? state : null;
  } catch {
    return null;
  }
}

function criteriaFor(kind, input) {
  if (!isObject(input)) return null;
  if (kind === 'choice') {
    if (isObject(input.criteria) && Object.keys(input.criteria).length) return input.criteria;
    if (!Array.isArray(input.choices) || !input.choices.length) return null;
    return Object.fromEntries(input.choices.filter((choice) => typeof choice === 'string' && choice.trim()).map((choice) => [choice, choice]));
  }
  if (kind === 'score') return Array.isArray(input.criteria) && input.criteria.length > 1 ? input.criteria : null;
  return isObject(input.criteria) && Object.hasOwn(input.criteria, 'true') && Object.hasOwn(input.criteria, 'false') ? input.criteria : null;
}

function cleanMetadata(value, depth = 0) {
  if (depth > 12 || value === null || ['string', 'number', 'boolean'].includes(typeof value)) return value;
  if (Array.isArray(value)) return value.map((item) => cleanMetadata(item, depth + 1));
  if (!isObject(value)) return String(value);
  const hidden = new Set(['state', 'input', 'prompt', 'memory', 'api_key', 'apikey', 'authorization', 'token', 'secret', 'password']);
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !hidden.has(key.toLowerCase()))
    .map(([key, item]) => [key, cleanMetadata(item, depth + 1)]));
}

function answerMetadata(body) {
  const safe = cleanMetadata(body);
  try {
    return Buffer.byteLength(JSON.stringify(safe)) <= 64_000 ? { openrouter: safe } : { openrouter: { id: safe?.id, model: safe?.model, provider: safe?.provider, usage: safe?.usage } };
  } catch {
    return { openrouter: {} };
  }
}

function operation(kind, { apiKey, fetch, model, timeout, maxStateBytes }) {
  return async (input, options = {}) => {
    const state = encodedState(input, maxStateBytes);
    const criteria = criteriaFor(kind, input);
    if (!apiKey || state === null || !criteria) return null;
    const question = { type: kind, instructions: typeof input.instructions === 'string' ? input.instructions : `Make a ${kind} decision.`, criteria };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetch(OPENROUTER_DECISIONS_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model, state, questions: { decision: question } }),
        signal: controller.signal,
      });
      if (!response?.ok) return null;
      const body = await response.json();
      const answer = body?.answers?.decision;
      const metadata = answerMetadata(body);
      if (!isObject(answer) || answer.type !== kind) return null;
      if (kind === 'choice') return typeof answer.choice === 'string' && Object.hasOwn(criteria, answer.choice) && isUnit(answer.confidence)
        ? { choice: answer.choice, confidence: answer.confidence, metadata } : null;
      if (kind === 'score') {
        const raw = answer.score;
        const denominator = criteria.length - 1;
        return Number.isFinite(raw) && raw >= 0 && raw <= denominator && isUnit(answer.confidence)
          ? { score: raw / denominator, confidence: answer.confidence, metadata } : null;
      }
      const probability = answer.noul;
      return isUnit(probability) ? { allowed: probability > options.threshold, confidence: probability, metadata } : null;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  };
}

export function createOpenRouterJevAdapter({
  apiKey,
  fetch: fetchImpl = globalThis.fetch,
  model = DEFAULT_JEV_MODEL,
  timeout = DEFAULT_JEV_TIMEOUT_MS,
  maxStateBytes = DEFAULT_MAX_STATE_BYTES,
} = {}) {
  const safeTimeout = positiveNumber(timeout, DEFAULT_JEV_TIMEOUT_MS);
  const safeStateBytes = positiveNumber(maxStateBytes, DEFAULT_MAX_STATE_BYTES);
  const config = { apiKey: typeof apiKey === 'string' && apiKey ? apiKey : '', fetch: typeof fetchImpl === 'function' ? fetchImpl : null, model, timeout: safeTimeout, maxStateBytes: safeStateBytes };
  return createDecisionAdapter({
    choice: operation('choice', config),
    score: operation('score', config),
    noul: operation('noul', config),
    timeout: safeTimeout + 10,
    provider: 'openrouter-jev',
  });
}

export function createOpenRouterJevAdapterFromEnv({ env = process.env, fetch } = {}) {
  return createOpenRouterJevAdapter({
    apiKey: env.OPENROUTER_API_KEY,
    model: env.CORAGENTIC_JEV_MODEL || DEFAULT_JEV_MODEL,
    timeout: positiveNumber(env.CORAGENTIC_JEV_TIMEOUT_MS, DEFAULT_JEV_TIMEOUT_MS),
    fetch,
  });
}
