import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { openDatabase } from './db.mjs';

const owner = '0x2222222222222222222222222222222222222222';
const other = '0x3333333333333333333333333333333333333333';
const token = 'graph-owner-session';
const hash = (value) => createHash('sha256').update(value).digest('hex');

async function port() { const s = createServer(); await new Promise((r) => s.listen(0, r)); const p = s.address().port; await new Promise((r) => s.close(r)); return p; }
function seed(path) {
  const db = openDatabase(path);
  const stamp = new Date().toISOString();
  db.prepare('INSERT INTO agents (id, owner_wallet, name, description, services_json, capabilities_json, supported_trust_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run('agent_own', owner, 'Own agent', 'd', '[]', '[]', '[]', stamp, stamp);
  db.prepare('INSERT INTO agents (id, owner_wallet, name, description, services_json, capabilities_json, supported_trust_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run('agent_other', other, 'Other agent', 'd', '[]', '[]', '[]', stamp, stamp);
  db.prepare('INSERT INTO agent_memory (id, agent_id, owner_wallet, memory_key, content, tags_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run('mem1', 'agent_own', owner, 'mission', 'Track payment risks weekly', '[]', stamp, stamp);
  db.prepare('INSERT INTO agent_memory (id, agent_id, owner_wallet, memory_key, content, tags_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run('mem2', 'agent_own', owner, 'operating-context', 'x402 settlement focus', '[]', stamp, stamp);
  db.prepare('INSERT INTO agent_runs (id, agent_id, owner_wallet, kind, request, result_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run('run1', 'agent_own', owner, 'brain', 'What are the risks?', '{"answer":"Payment risk","confidence":0.9}', stamp);
  db.prepare('INSERT INTO sessions VALUES (?, ?, ?)').run(hash(token), owner, Date.now() + 60_000);
  db.close();
}
async function start(path) {
  const p = await port();
  const child = spawn(process.execPath, ['server/index.mjs'], { cwd: process.cwd(), env: { ...process.env, PORT: String(p), CORAGENTIC_DB: path }, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('server did not start')), 3000); child.stdout.on('data', (c) => { if (String(c).includes('listening')) { clearTimeout(timer); resolve(); } }); child.once('error', reject); });
  return { child, base: `http://127.0.0.1:${p}` };
}
async function stop(child) { child.kill(); await new Promise((r) => child.once('exit', r)); }

test('GET /v1/graph returns the signed-in owner knowledge graph and nothing cross-owner', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'coragentic-graph-'));
  const path = join(dir, 'db.sqlite');
  seed(path);
  const { child, base } = await start(path);
  try {
    const res = await fetch(`${base}/v1/graph`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(res.status, 200);
    const body = await res.json();
    const { nodes, links, summary } = body.data;
    const ids = nodes.map((n) => n.id);
    // own agent + its memory + its run present
    assert.ok(ids.includes('agent_own'));
    assert.ok(ids.includes('mem1'));
    assert.ok(ids.includes('run1'));
    // cross-owner data never leaks
    assert.ok(!ids.includes('agent_other'));
    // edges connect memory/run to their agent
    assert.ok(links.some((l) => l.source === 'agent_own' && l.target === 'mem1'));
    assert.ok(links.some((l) => l.source === 'agent_own' && l.target === 'run1'));
    assert.equal(summary.agents, 1);
    assert.ok(summary.memories >= 2);
    assert.ok(summary.runs >= 1);
  } finally { await stop(child); rmSync(dir, { recursive: true, force: true }); }
});

test('GET /v1/graph requires a session', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'coragentic-graph-'));
  const path = join(dir, 'db.sqlite');
  seed(path);
  const { child, base } = await start(path);
  try {
    const res = await fetch(`${base}/v1/graph`);
    assert.equal(res.status, 401);
  } finally { await stop(child); rmSync(dir, { recursive: true, force: true }); }
});
