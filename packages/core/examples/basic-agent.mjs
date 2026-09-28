import { createAgentRuntime } from '../src/runtime.mjs';

const manifest = {
  id: 'did:example:coragentic-demo',
  name: 'Basic deterministic agent',
  version: '0.1.0',
  services: [{ id: 'local-tools', type: 'tool', tools: ['quote', 'spend'] }],
};

const events = [];
const runtime = createAgentRuntime({
  manifest,
  policy: { maxAtomicPerCall: '1000', dailyAtomic: '1500', allowedAssets: ['USDC'], allowedRecipients: ['demo-recipient'] },
  audit: (event) => events.push(event),
  tools: {
    quote: { inputSchema: (input) => typeof input.asset === 'string', execute: (input) => ({ asset: input.asset, amountAtomic: '100' }) },
    spend: { inputSchema: (input) => typeof input.amountAtomic === 'string', execute: (input) => ({ acceptedByTool: true, amountAtomic: input.amountAtomic }) },
  },
});

console.log(JSON.stringify(await runtime.executeTool('quote', { asset: 'USDC' })));
console.log(JSON.stringify(await runtime.executeTool('spend', { amountAtomic: '250', asset: 'USDC', recipient: 'demo-recipient' }, { request: { type: 'spend', amountAtomic: '250', asset: 'USDC', recipient: 'demo-recipient' } })));
console.log(JSON.stringify(events, null, 2));
