const CHAIN_ID_VALUE = '4663';
const CHAIN_NAME = 'Robinhood Chain';
const A2A_PROTOCOL_VERSION = '0.3.0';
const VERIFICATION = Object.freeze({ status: 'unverified', onchain: false });

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortValue(value[key])]));
}

export function canonicalJson(value) {
  return JSON.stringify(sortValue(value));
}

function parseJson(value, fallback) {
  if (isObject(value) || Array.isArray(value)) return value;
  if (typeof value !== 'string') return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

function text(value, fallback = '') {
  return typeof value === 'string' ? value.trim() : fallback;
}

function baseUrl(value) {
  return text(value, 'http://localhost:8787').replace(/\/+$/, '');
}

function chainMetadata() {
  return { namespace: 'eip155', chainId: CHAIN_ID_VALUE, name: CHAIN_NAME, rpcUrl: null };
}

function verificationMetadata() {
  return { ...VERIFICATION };
}

function serviceList(row) {
  const services = parseJson(row?.services_json ?? row?.services, []);
  return (Array.isArray(services) ? services : []).filter(isObject).map((service) => ({
    endpoint: text(service.endpoint),
    type: text(service.type, 'service'),
  })).filter((service) => service.endpoint).sort((a, b) => `${a.type}:${a.endpoint}`.localeCompare(`${b.type}:${b.endpoint}`));
}

function capabilities(row) {
  const values = parseJson(row?.capabilities_json ?? row?.capabilities, []);
  const list = Array.isArray(values) ? values : [];
  return [...new Set(list.map((item) => (typeof item === 'string' ? item.trim() : item?.id)).filter(Boolean))].sort();
}

function skill(id) {
  return { id, name: id, description: `Coragentic ${id} capability.` };
}

export function buildAgentCard(row = {}, { baseUrl: origin } = {}) {
  const id = text(row.id, 'unknown-agent');
  const card = {
    protocolVersion: A2A_PROTOCOL_VERSION,
    name: text(row.name, id),
    description: text(row.description, 'Coragentic agent'),
    url: `${baseUrl(origin)}/a2a/agents/${encodeURIComponent(id)}`,
    version: '1.0.0',
    iconUrl: text(row.image) || undefined,
    capabilities: { streaming: false, pushNotifications: false, stateTransitionHistory: false },
    skills: capabilities(row).map(skill),
    defaultInputModes: ['text/plain', 'application/json'],
    defaultOutputModes: ['text/plain', 'application/json'],
    authentication: { schemes: ['bearer'] },
    services: serviceList(row),
    metadata: {
      agentId: id,
      chain: chainMetadata(),
      verification: verificationMetadata(),
      x402Support: Boolean(row.x402_support ?? row.x402Support),
    },
  };
  return sortValue(card);
}

const MCP_TOOLS = [
  ['memory', 'Read and write agent memory.'],
  ['offerings', 'Discover and manage agent offerings.'],
  ['jobs', 'Inspect and manage marketplace jobs.'],
  ['audit', 'Read audit events for Coragentic entities.'],
  ['market', 'Discover marketplace and network information.'],
];

export function buildMcpManifest({ baseUrl: origin } = {}) {
  const root = baseUrl(origin);
  return sortValue({
    name: 'coragentic',
    version: '1.0.0',
    description: 'Coragentic MCP tool discovery manifest.',
    serverUrl: `${root}/mcp`,
    tools: MCP_TOOLS.map(([name, description]) => ({
      name,
      description,
      inputSchema: { type: 'object', additionalProperties: true },
    })),
    metadata: { chain: chainMetadata(), verification: verificationMetadata() },
  });
}

export function validateAgentCard(card) {
  const errors = [];
  if (!isObject(card)) errors.push('card must be an object');
  else {
    for (const field of ['protocolVersion', 'name', 'description', 'url', 'version']) {
      if (typeof card[field] !== 'string' || !card[field].trim()) errors.push(`${field} is required`);
    }
    if (!Array.isArray(card.skills)) errors.push('skills must be an array');
    if (!isObject(card.authentication) || !Array.isArray(card.authentication.schemes)) errors.push('authentication.schemes is required');
    if (card.metadata?.verification?.status !== 'unverified' || card.metadata?.verification?.onchain !== false) errors.push('on-chain status must remain explicitly unverified');
    if (card.metadata?.onchain === true || card.onchain === true || card.verified === true || card.metadata?.verified === true || card.metadata?.verification?.claims !== undefined) errors.push('fake on-chain claims are not allowed');
  }
  return { valid: errors.length === 0, errors };
}

export const ROUTE_INTEGRATION_INSTRUCTIONS = Object.freeze({
  agentCard: 'In server/index.mjs, GET /.well-known/agent.json should return buildAgentCard(row) for the public/default agent (or a documented aggregate card). For a specific agent, GET /a2a/agents/:id should load agents.id and return the card.',
  mcpManifest: 'In server/index.mjs, GET /mcp/manifest.json (and optionally /.well-known/mcp.json) should return buildMcpManifest({ baseUrl: origin }); route tool calls to the existing memory, offerings, jobs, audit, and market handlers.',
  safety: 'Keep metadata.verification.status="unverified" and metadata.verification.onchain=false until a verified registry read proves an on-chain claim.',
});

export const CHAIN_ID = CHAIN_ID_VALUE;
export const createAgentCard = buildAgentCard;
export const createMcpManifest = buildMcpManifest;
export const serializeAgentCard = (row, options) => canonicalJson(buildAgentCard(row, options));
export const serializeMcpManifest = (options) => canonicalJson(buildMcpManifest(options));
