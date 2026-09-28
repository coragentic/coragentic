import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const bin = resolve(here, '../src/index.mjs');

function request(proc, message) {
  return new Promise((resolvePromise, reject) => {
    const onData = (chunk) => {
      for (const line of chunk.toString().split('\n').filter(Boolean)) {
        try {
          const value = JSON.parse(line);
          if (value.id === message.id) {
            proc.stdout.off('data', onData);
            resolvePromise(value);
          }
        } catch { /* SDK diagnostics must not be parsed as protocol messages. */ }
      }
    };
    proc.stdout.on('data', onData);
    proc.once('error', reject);
    proc.stdin.write(`${JSON.stringify(message)}\n`);
  });
}

test('stdio initialize and tools/list expose all Coragentic tools', async (t) => {
  const proc = spawn(process.execPath, [bin], { env: { ...process.env, CORAGENTIC_API_URL: 'http://127.0.0.1:9' } });
  t.after(() => proc.kill());
  const initialized = await request(proc, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '1' } } });
  assert.equal(initialized.result.serverInfo.name, '@coragentic/mcp');
  assert.ok(initialized.result.capabilities.tools);
  proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })}\n`);
  const listed = await request(proc, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  assert.deepEqual(listed.result.tools.map((tool) => tool.name), [
    'discover_agents', 'get_agent_card', 'recall_memory', 'list_offerings', 'get_job', 'swarm_status', 'market_context', 'rh_quote_swap', 'rh_swap_preview', 'rh_swap_status',
  ]);
  for (const tool of listed.result.tools) assert.equal(tool.inputSchema.type, 'object');
  proc.stdin.end();
  await new Promise((resolvePromise) => proc.once('exit', resolvePromise));
});
