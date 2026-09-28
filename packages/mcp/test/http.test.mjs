import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createNodeServer } from 'node:http';
import { createHttpService } from '../src/http-service.mjs';

const rpc = (id, method, params = {}) => ({ jsonrpc: '2.0', id, method, params });
const initialize = () => rpc(1, 'initialize', {
  protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'contract', version: '1' },
});

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

async function post(base, body, token) {
  return fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { accept: 'application/json, text/event-stream', 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
}

test('Streamable HTTP MCP rejects missing and invalid bearer tokens, serves health, and handles initialize/tools/list', async (t) => {
  const service = createHttpService({
    env: { CORAGENTIC_MCP_TOKENS: JSON.stringify({ 'contract-token': 'upstream-contract-token' }), CORAGENTIC_API_URL: 'http://127.0.0.1:9' },
    logger: { error() {} },
  });
  const base = await listen(service);
  t.after(() => service.close());

  assert.equal((await fetch(`${base}/healthz`)).status, 200);
  assert.deepEqual(await (await fetch(`${base}/healthz`)).json(), { status: 'ready' });
  assert.equal((await post(base, initialize())).status, 401);
  assert.equal((await post(base, initialize(), 'not-a-token')).status, 401);

  const initialized = await post(base, initialize(), 'contract-token');
  assert.equal(initialized.status, 200);
  assert.equal((await initialized.json()).result.serverInfo.name, '@coragentic/mcp');

  const listed = await post(base, rpc(2, 'tools/list'), 'contract-token');
  assert.equal(listed.status, 200);
  assert.ok((await listed.json()).result.tools.some((tool) => tool.name === 'discover_agents'));
});

test('remote tool calls forward only the explicitly mapped upstream bearer token', async (t) => {
  let authorization;
  const api = createNodeServer((request, response) => {
    authorization = request.headers.authorization;
    response.setHeader('content-type', 'application/json');
    response.end('[]');
  });
  const apiBase = await listen(api);
  t.after(() => api.close());

  const service = createHttpService({
    env: { CORAGENTIC_MCP_TOKENS: JSON.stringify({ 'contract-token': 'upstream-contract-token' }), CORAGENTIC_API_URL: apiBase },
    logger: { error() {} },
  });
  const base = await listen(service);
  t.after(() => service.close());

  const response = await post(base, rpc(3, 'tools/call', { name: 'discover_agents', arguments: {} }), 'contract-token');
  assert.equal(response.status, 200);
  assert.equal(authorization, 'Bearer upstream-contract-token');
});
