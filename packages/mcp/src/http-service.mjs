import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer as createNodeServer } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createServer } from './index.mjs';

const MAX_MAPPINGS = 32;
const MAX_ENV_BYTES = 32 * 1024;
const MAX_TOKEN_BYTES = 512;
const MAX_UPSTREAM_TOKEN_BYTES = 2048;
const MAX_BODY_BYTES = 1024 * 1024;
const DEFAULT_RATE_LIMIT = 60;
const DEFAULT_RATE_WINDOW_MS = 60_000;
const MAX_LIMITER_KEYS = 10_000;

// Self-contained security headers + rate limiter for this npm-published package.
// This intentionally does NOT import server/security.mjs: packages/mcp ships as
// its own npm tarball (see package.json "files") without the server/ directory,
// so a cross-package relative import would work in this monorepo checkout but
// break the moment @coragentic/mcp is installed from the registry. Keep the two
// implementations independently maintained rather than coupling their release
// cycles.
function securityHeaders() {
  return {
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
    'content-security-policy': "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
  };
}

function createRateLimiter({ limit = DEFAULT_RATE_LIMIT, windowMs = DEFAULT_RATE_WINDOW_MS, maxKeys = MAX_LIMITER_KEYS } = {}) {
  const windows = new Map();
  return {
    check(identity) {
      const key = identity || 'unknown';
      const timestamp = Date.now();
      const cutoff = timestamp - windowMs;
      let timestamps = windows.get(key);
      if (!timestamps) { timestamps = []; windows.set(key, timestamps); }
      while (timestamps.length && timestamps[0] <= cutoff) timestamps.shift();
      if (timestamps.length >= limit) {
        const retryAfterMs = Math.max(0, timestamps[0] + windowMs - timestamp);
        return { allowed: false, retryAfterSeconds: Math.ceil(retryAfterMs / 1000) };
      }
      timestamps.push(timestamp);
      if (windows.size > maxKeys) windows.delete(windows.keys().next().value);
      return { allowed: true };
    },
  };
}

function configError() {
  throw new Error('Invalid CORAGENTIC_MCP_TOKENS configuration');
}

function tokenHash(token) {
  return createHash('sha256').update(token).digest();
}

export function createTokenVerifier(raw) {
  if (typeof raw !== 'string' || !raw || Buffer.byteLength(raw) > MAX_ENV_BYTES) configError();
  let mappings;
  try { mappings = JSON.parse(raw); } catch { configError(); }
  if (!mappings || Array.isArray(mappings) || typeof mappings !== 'object') configError();
  const entries = Object.entries(mappings);
  if (!entries.length || entries.length > MAX_MAPPINGS) configError();
  return entries.map(([clientToken, upstreamToken]) => {
    if (typeof clientToken !== 'string' || typeof upstreamToken !== 'string'
      || !clientToken || Buffer.byteLength(clientToken) > MAX_TOKEN_BYTES
      || !upstreamToken || Buffer.byteLength(upstreamToken) > MAX_UPSTREAM_TOKEN_BYTES) configError();
    return { hash: tokenHash(clientToken), upstreamToken };
  });
}

function mappedUpstreamToken(request, entries) {
  const header = request.headers.authorization;
  const match = typeof header === 'string' && /^Bearer ([^\s]+)$/i.exec(header);
  if (!match || Buffer.byteLength(match[1]) > MAX_TOKEN_BYTES) return undefined;
  const presented = tokenHash(match[1]);
  let selected = -1;
  for (let index = 0; index < entries.length; index += 1) {
    if (timingSafeEqual(presented, entries[index].hash)) selected = index;
  }
  return selected < 0 ? undefined : entries[selected].upstreamToken;
}

function sendJson(response, status, body, extraHeaders = {}) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...securityHeaders(), ...extraHeaders });
  response.end(JSON.stringify(body));
}

async function readJson(request) {
  const declaredLength = Number(request.headers['content-length']);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) throw new RangeError('too large');
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > MAX_BODY_BYTES) throw new RangeError('too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export function createHttpService({ env = process.env, logger = console, rateLimiter } = {}) {
  const entries = createTokenVerifier(env.CORAGENTIC_MCP_TOKENS);
  const apiUrl = (env.CORAGENTIC_API_URL || '').replace(/\/+$/, '');
  const limiter = rateLimiter && typeof rateLimiter.check === 'function' ? rateLimiter : createRateLimiter(rateLimiter);
  return createNodeServer(async (request, response) => {
    for (const [name, value] of Object.entries(securityHeaders())) response.setHeader(name, value);
    if (request.method === 'GET' && request.url === '/healthz') return sendJson(response, 200, { status: 'ready' });
    if (request.method !== 'POST' || request.url !== '/mcp') return sendJson(response, 404, { error: 'not found' });

    // Rate-limit by client IP so the MCP transport can't be flooded the way the
    // main API is already protected against (server/security.mjs), even though
    // a valid bearer token is presented -- an unbounded stream of authenticated
    // /mcp POSTs still spins up a fresh transport+server per request.
    const identity = request.headers['x-forwarded-for']?.split(',')[0]?.trim() || request.socket.remoteAddress || 'unknown';
    const limited = limiter.check(identity);
    if (!limited.allowed) {
      if (limited.retryAfterSeconds) response.setHeader('retry-after', String(limited.retryAfterSeconds));
      return sendJson(response, 429, { error: 'rate_limited', retryAfterSeconds: limited.retryAfterSeconds });
    }

    const upstreamToken = mappedUpstreamToken(request, entries);
    if (!upstreamToken) return sendJson(response, 401, { error: 'unauthorized' });

    let body;
    try { body = await readJson(request); } catch (error) {
      return sendJson(response, error instanceof RangeError ? 413 : 400, { error: 'invalid request body' });
    }
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    const server = createServer({ apiUrl, upstreamToken });
    try {
      await server.connect(transport);
      await transport.handleRequest(request, response, body);
    } catch (error) {
      logger.error('MCP HTTP request failed');
      if (!response.headersSent) sendJson(response, 500, { error: 'internal server error' });
    } finally {
      await server.close().catch(() => {});
    }
  });
}
