import { randomUUID } from 'node:crypto';

const DEFAULT_WINDOW_MS = 60_000;
const DEFAULT_LIMIT = 60;
const DEFAULT_MAX_KEYS = 10_000;

function positiveInteger(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function normalizeIdentity(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** A bounded, in-memory sliding-window limiter for process-local protection. */
export class SlidingWindowRateLimiter {
  constructor({ limit = DEFAULT_LIMIT, windowMs = DEFAULT_WINDOW_MS, maxKeys = DEFAULT_MAX_KEYS, now = Date.now } = {}) {
    this.limit = positiveInteger(limit, DEFAULT_LIMIT);
    this.windowMs = positiveInteger(windowMs, DEFAULT_WINDOW_MS);
    this.maxKeys = positiveInteger(maxKeys, DEFAULT_MAX_KEYS);
    this.now = now;
    this.windows = new Map();
  }

  get size() {
    return this.windows.size;
  }

  #prune(timestamp) {
    const cutoff = timestamp - this.windowMs;
    for (const [key, timestamps] of this.windows) {
      while (timestamps[0] <= cutoff) timestamps.shift();
      if (timestamps.length === 0) this.windows.delete(key);
    }
    while (this.windows.size > this.maxKeys) this.windows.delete(this.windows.keys().next().value);
  }

  #checkKey(key, timestamp) {
    let timestamps = this.windows.get(key);
    if (!timestamps) {
      timestamps = [];
      this.windows.set(key, timestamps);
    }
    while (timestamps[0] <= timestamp - this.windowMs) timestamps.shift();
    if (timestamps.length >= this.limit) {
      const retryAfter = Math.max(0, timestamps[0] + this.windowMs - timestamp);
      return { allowed: false, remaining: 0, retryAfter };
    }
    timestamps.push(timestamp);
    return { allowed: true, remaining: this.limit - timestamps.length, retryAfter: 0 };
  }

  check({ ip, wallet } = {}) {
    const identities = [
      ['ip', normalizeIdentity(ip)],
      ['wallet', normalizeIdentity(wallet)],
    ].filter(([, value]) => value).map(([kind, value]) => `${kind}:${value}`);
    if (identities.length === 0) identities.push('ip:unknown');

    const timestamp = this.now();
    this.#prune(timestamp);
    const results = identities.map((key) => this.#checkKey(key, timestamp));
    const blocked = results.find((result) => !result.allowed);
    const remaining = Math.min(...results.map((result) => result.remaining));
    const retryAfter = blocked ? Math.max(...results.map((result) => result.retryAfter)) : 0;
    this.#prune(timestamp);
    return {
      allowed: !blocked,
      limit: this.limit,
      remaining,
      retryAfter,
      retryAfterSeconds: Math.ceil(retryAfter / 1_000),
    };
  }

  consume(identity) {
    return this.check(identity);
  }
}

export function createRateLimiter(options) {
  return new SlidingWindowRateLimiter(options);
}

function allowedOrigins(env = process.env) {
  const configured = env.CORS_ORIGINS ?? env.CORS_ORIGIN ?? '';
  return new Set(String(configured).split(',').map((origin) => origin.trim()).filter(Boolean));
}

export function isOriginAllowed(origin, env = process.env) {
  return typeof origin === 'string' && allowedOrigins(env).has(origin);
}

export function getCorsHeaders(origin, env = process.env) {
  if (!isOriginAllowed(origin, env)) return { vary: 'Origin' };
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-credentials': 'true',
    vary: 'Origin',
  };
}

export function getSecurityHeaders({ production = process.env.NODE_ENV === 'production' } = {}) {
  const headers = {
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
    'content-security-policy': "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
  };
  if (production) headers['strict-transport-security'] = 'max-age=31536000; includeSubDomains';
  return headers;
}

export function formatPublicError(_error, { correlationId = randomUUID(), code = 'internal_error' } = {}) {
  return { ok: false, error: code, correlationId };
}
