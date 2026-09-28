#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const SERVER_VERSION = '0.1.0';

function configuredApiUrl(value = process.env.CORAGENTIC_API_URL || '') {
  return value.replace(/\/+$/, '');
}

const stringProperty = (description) => ({ type: 'string', description });
const integerProperty = (description, minimum = 1, maximum = 100) => ({ type: 'integer', minimum, maximum, description });

export const TOOLS = [
  {
    name: 'discover_agents',
    description: 'List agents currently exposed by the Coragentic API.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    path: () => '/v1/agents',
  },
  {
    name: 'get_agent_card',
    description: 'Fetch the A2A agent card for one Coragentic agent.',
    inputSchema: { type: 'object', properties: { agentId: stringProperty('Agent identifier') }, required: ['agentId'], additionalProperties: false },
    path: ({ agentId }) => `/a2a/agents/${encodeURIComponent(agentId)}`,
  },
  {
    name: 'recall_memory',
    description: 'Read memory records for an agent, optionally filtered by a query.',
    inputSchema: { type: 'object', properties: { agentId: stringProperty('Agent identifier'), query: stringProperty('Optional full-text query'), limit: integerProperty('Maximum records to return') }, required: ['agentId'], additionalProperties: false },
    path: ({ agentId, query, limit }) => {
      const params = new URLSearchParams();
      if (query) params.set('q', query);
      if (limit !== undefined) params.set('limit', String(limit));
      return `/v1/agents/${encodeURIComponent(agentId)}/memory${params.size ? `?${params}` : ''}`;
    },
  },
  {
    name: 'list_offerings',
    description: 'List active offerings for one Coragentic agent.',
    inputSchema: { type: 'object', properties: { agentId: stringProperty('Agent identifier') }, required: ['agentId'], additionalProperties: false },
    path: ({ agentId }) => `/v1/agents/${encodeURIComponent(agentId)}/offerings`,
  },
  {
    name: 'get_job',
    description: 'Fetch one marketplace job. The API may require a valid session.',
    inputSchema: { type: 'object', properties: { jobId: stringProperty('Job identifier') }, required: ['jobId'], additionalProperties: false },
    path: ({ jobId }) => `/v1/jobs/${encodeURIComponent(jobId)}`,
  },
  {
    name: 'swarm_status',
    description: 'Fetch Coragentic swarm status from the API.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    path: () => '/v1/swarm/status',
  },
  {
    name: 'market_context',
    description: 'Fetch current Coragentic network and market context.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    path: () => '/v1/network',
  },
  {
    name: 'rh_quote_swap',
    description: 'Quote a Robinhood Chain swap using live QuoterV2; read-only and never signed or broadcast.',
    inputSchema: { type: 'object', properties: { token: { type: 'string', description: 'Output ERC-20 token address.' }, amount: { type: 'string', description: 'Positive decimal native ETH/WETH amount.' }, amountDecimals: { type: 'integer', minimum: 0, maximum: 255, description: 'Input decimals; defaults to 18.' }, slippageBps: { type: 'integer', minimum: 0, maximum: 10000, description: 'Slippage basis points; defaults to 50.' } }, required: ['token', 'amount'], additionalProperties: false },
    path: ({ token, amount, amountDecimals, slippageBps }) => { const params = new URLSearchParams({ token, amount }); if (amountDecimals !== undefined) params.set('amountDecimals', String(amountDecimals)); if (slippageBps !== undefined) params.set('slippageBps', String(slippageBps)); return `/v1/market/quote?${params}`; },
  },
  {
    name: 'rh_swap_preview',
    description: 'Build unsigned Robinhood Chain calldata; an external wallet must review, sign, and broadcast it.',
    inputSchema: { type: 'object', properties: { token: { type: 'string', description: 'Output ERC-20 token address.' }, amount: { type: 'string', description: 'Positive decimal native ETH/WETH amount.' }, wallet: { type: 'string', description: 'Externally controlled recipient wallet.' }, amountDecimals: { type: 'integer', minimum: 0, maximum: 255, description: 'Input decimals; defaults to 18.' }, slippageBps: { type: 'integer', minimum: 0, maximum: 10000, description: 'Slippage basis points; defaults to 50.' } }, required: ['token', 'amount', 'wallet'], additionalProperties: false },
    path: ({ token, amount, wallet, amountDecimals, slippageBps }) => { const params = new URLSearchParams({ token, amount, wallet }); if (amountDecimals !== undefined) params.set('amountDecimals', String(amountDecimals)); if (slippageBps !== undefined) params.set('slippageBps', String(slippageBps)); return `/v1/market/swap-preview?${params}`; },
  },
  {
    name: 'rh_swap_status',
    description: 'Look up a Robinhood Chain receipt by transaction hash; does not submit or alter transactions.',
    inputSchema: { type: 'object', properties: { txHash: { type: 'string', pattern: '^0x[0-9a-fA-F]{64}$', description: 'Transaction hash.' } }, required: ['txHash'], additionalProperties: false },
    path: ({ txHash }) => `/v1/market/swap-status?txHash=${encodeURIComponent(txHash)}`,
  },
];

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function errorResult(message, details = undefined) {
  const payload = details === undefined ? { error: message } : { error: message, details };
  return { isError: true, content: [{ type: 'text', text: JSON.stringify(payload) }] };
}

async function callApi(tool, args, { apiUrl, upstreamToken }) {
  if (!apiUrl) return errorResult('CORAGENTIC_API_URL is not set');
  let url;
  try { url = new URL(tool.path(args), `${apiUrl}/`); } catch { return errorResult('Invalid CORAGENTIC_API_URL'); }
  try {
    const headers = { accept: 'application/json' };
    if (upstreamToken) headers.authorization = `Bearer ${upstreamToken}`;
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(30_000) });
    const raw = await response.text();
    let body;
    try { body = raw ? JSON.parse(raw) : null; } catch { body = raw; }
    if (!response.ok) return errorResult(`Coragentic API returned HTTP ${response.status}`, body);
    return { content: [{ type: 'text', text: JSON.stringify(body) }] };
  } catch (error) {
    return errorResult('Coragentic API request failed', { message: error instanceof Error ? error.message : String(error) });
  }
}

export function createServer({ apiUrl = configuredApiUrl(), upstreamToken } = {}) {
  const server = new Server({ name: '@coragentic/mcp', version: SERVER_VERSION }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS.map(({ path: _path, ...tool }) => tool) }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = TOOLS.find((candidate) => candidate.name === request.params.name);
    if (!tool) return errorResult(`Unknown tool: ${request.params.name}`);
    const args = request.params.arguments && typeof request.params.arguments === 'object' ? request.params.arguments : {};
    return callApi(tool, args, { apiUrl, upstreamToken });
  });
  return server;
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
