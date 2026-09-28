const DEFAULT_THRESHOLD = 0.5;
const DEFAULT_TIMEOUT = 1_000;

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isUnit = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;

function thresholdOf(options = {}) {
  const threshold = options?.threshold ?? DEFAULT_THRESHOLD;
  if (!isUnit(threshold)) throw new RangeError('threshold must be a finite number between 0 and 1');
  return threshold;
}

function timeoutOf(value) {
  const timeout = value ?? DEFAULT_TIMEOUT;
  if (!Number.isFinite(timeout) || timeout <= 0) throw new RangeError('timeout must be a positive number');
  return timeout;
}

function metadata(provider, value) {
  return isObject(value) ? { ...value, provider } : { provider };
}

function typed(kind, result, threshold, provider) {
  if (!isObject(result) || !isUnit(result.confidence)) return null;
  const base = { kind, confidence: result.confidence, threshold, provider, metadata: metadata(provider, result.metadata) };
  if (kind === 'choice') {
    if (typeof result.choice !== 'string' || !result.choice.trim()) return null;
    return { kind, choice: result.choice, confidence: result.confidence, threshold, accepted: result.confidence >= threshold, provider, metadata: base.metadata };
  }
  if (kind === 'score') {
    if (!isUnit(result.score)) return null;
    return { kind, score: result.score, confidence: result.confidence, threshold, accepted: result.confidence >= threshold, provider, metadata: base.metadata };
  }
  if (typeof result.allowed !== 'boolean') return null;
  const allowed = result.allowed && result.confidence >= threshold;
  return { kind, allowed, confidence: result.confidence, threshold, accepted: allowed, provider, metadata: base.metadata };
}

function offlineValue(kind, input, threshold) {
  if (kind === 'choice') {
    const choices = isObject(input) && Array.isArray(input.choices) ? input.choices : [];
    return typed(kind, { choice: typeof choices[0] === 'string' ? choices[0] : 'offline', confidence: 1 }, threshold, 'offline');
  }
  if (kind === 'score') return typed(kind, { score: 0.5, confidence: 1 }, threshold, 'offline');
  return typed(kind, { allowed: false, confidence: 1 }, threshold, 'offline');
}

export function createOfflineDecisionAdapter() {
  return createDecisionAdapter({
    choice: (input) => offlineValue('choice', input, DEFAULT_THRESHOLD),
    score: () => ({ score: 0.5, confidence: 1 }),
    noul: () => ({ allowed: false, confidence: 1 }),
    provider: 'offline',
  });
}

export const offlineDecisionAdapter = createOfflineDecisionAdapter();

export function createDecisionAdapter({ choice, score, noul, fallback, timeout, provider = 'jev' } = {}) {
  const timeoutMs = timeoutOf(timeout);
  const fallbackValue = fallback;

  async function run(kind, input, options = {}) {
    const threshold = thresholdOf(options);
    const operation = { choice, score, noul }[kind];
    let result;
    let failure;
    if (typeof operation === 'function') {
      try {
        result = await Promise.race([
          Promise.resolve().then(() => operation(input, options)),
          new Promise((_, reject) => setTimeout(() => reject(Object.assign(new Error(`${kind} provider timed out`), { code: 'timeout' })), timeoutMs)),
        ]);
        const validated = typed(kind, result, threshold, provider);
        if (validated) return validated;
        failure = Object.assign(new Error(`${kind} provider returned a malformed result`), { code: 'malformed_result' });
      } catch (error) {
        failure = error;
      }
    } else {
      failure = Object.assign(new Error(`${kind} provider is unavailable`), { code: 'unavailable' });
    }

    let fallbackResult;
    if (typeof fallbackValue === 'function') {
      fallbackResult = await fallbackValue({ kind, input, options, threshold, error: failure });
    } else if (fallbackValue !== undefined) {
      fallbackResult = fallbackValue;
    }
    const validatedFallback = typed(kind, fallbackResult, threshold, 'fallback');
    return validatedFallback || offlineValue(kind, input, threshold);
  }

  return Object.freeze({
    choice: (input, options) => run('choice', input, options),
    score: (input, options) => run('score', input, options),
    noul: (input, options) => run('noul', input, options),
    batchChoice: (inputs, options) => {
      if (!Array.isArray(inputs)) return Promise.reject(new TypeError('batchChoice inputs must be an array'));
      return Promise.all(inputs.map((input) => run('choice', input, options)));
    },
  });
}
