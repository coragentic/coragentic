import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { openDatabase } from './db.mjs';
import { USDG_ADDRESS } from './x402-onchain-verifier.mjs';

const owner = '0x1111111111111111111111111111111111111111';
const token = 'owner-session';
const hash = (value) => createHash('sha256').update(value).digest('hex');

async function port() { const server = createServer(); await new Promise((resolve) => server.listen(0, resolve)); const value = server.address().port; await new Promise((resolve) => server.close(resolve)); return value; }
function seed(path) {
  const db = openDatabase(path); const now = '2026-01-01T00:00:00.000Z';
  db.prepare('INSERT INTO sessions VALUES (?, ?, ?)').run(hash(token), owner, Date.now() + 60_000);
  db.prepare('INSERT INTO agents VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run('agent-a', owner, 'agent-a', 'test', null, '[]', '[]', '[]', 0, 'draft', now, now);
  db.close();
}
async function start(path) { const p = await port(); const child = spawn(process.execPath, ['server/index.mjs'], { cwd: process.cwd(), env: { ...process.env, PORT: String(p), CORAGENTIC_DB: path }, stdio: ['ignore', 'pipe', 'pipe'] }); await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('server did not start')), 3000); child.stdout.on('data', (chunk) => { if (String(chunk).includes('listening')) { clearTimeout(timer); resolve(); } }); child.once('error', reject); }); return { child, base: `http://127.0.0.1:${p}` }; }
async function stop(child) { child.kill(); await new Promise((resolve) => child.once('exit', resolve)); }

test('offering creation rejects any asset that is not the supported USDG contract', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'coragentic-offering-asset-')); const path = join(dir, 'db.sqlite'); seed(path); const { child, base } = await start(path);
  try {
    const res = await fetch(`${base}/v1/agents/agent-a/offerings`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ name: 'offer', description: 'test', priceAtomic: '1000000', asset: '0xNotARealToken0000000000000000000000000', network: 'eip155:4663', requirements: {}, deliverables: {} }),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error, 'unsupported_asset');

    const ok = await fetch(`${base}/v1/agents/agent-a/offerings`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ name: 'offer', description: 'test', priceAtomic: '1000000', asset: USDG_ADDRESS, network: 'eip155:4663', requirements: {}, deliverables: {} }),
    });
    assert.equal(ok.status, 201);
  } finally { await stop(child); rmSync(dir, { recursive: true, force: true }); }
});
