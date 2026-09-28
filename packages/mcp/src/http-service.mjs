import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer as createNodeServer } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createServer } from './index.mjs';

const MAX_MAPPINGS = 32;
const MAX_ENV_BYTES = 32 * 1024;
const MAX_TOKEN_BYTES = 512;
const MAX_UPSTREAM_TOKEN_BYTES = 2048;
const MAX_BODY_BYTES = 1024 * 1024;

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

function sendJson(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
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

export function createHttpService({ env = process.env, logger = console } = {}) {
  const entries = createTokenVerifier(env.CORAGENTIC_MCP_TOKENS);
  const apiUrl = (env.CORAGENTIC_API_URL || '').replace(/\/+$/, '');
  return createNodeServer(async (request, response) => {
    if (request.method === 'GET' && request.url === '/healthz') return sendJson(response, 200, { status: 'ready' });
    if (request.method !== 'POST' || request.url !== '/mcp') return sendJson(response, 404, { error: 'not found' });
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
