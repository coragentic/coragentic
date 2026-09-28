import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { openDatabase } from './db.mjs';
import { migrateRagSchema, indexMemory } from './rag.mjs';

const wallet = '0x1111111111111111111111111111111111111111';
const other = '0x2222222222222222222222222222222222222222';
const token = 'test-session-token';
const stamp = '2026-01-01T00:00:00.000Z';
const hash = (value) => createHash('sha256').update(value).digest('hex');

async function port() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, resolve));
  const value = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return value;
}

function seed(path) {
  const db = openDatabase(path);
  migrateRagSchema(db);
  db.prepare('INSERT INTO sessions VALUES (?, ?, ?)').run(hash(token), wallet, Date.now() + 60_000);
  for (const [id, owner] of [['agent-a', wallet], ['agent-b', other]]) {
    db.prepare('INSERT INTO agents VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, owner, id, 'test agent', null, '[]', '[]', '[]', 0, 'draft', stamp, stamp);
  }
  db.prepare('INSERT INTO agent_memory VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run('private-memory', 'agent-a', wallet, 'deployment', 'private deploy instruction', '[]', stamp, stamp);
  indexMemory(db, { id: 'private-memory', memoryKey: 'deployment', content: 'private deploy instruction', tags: [] });
  db.close();
}

async function start(path, env = {}) {
  const value = await port();
  const child = spawn(process.execPath, ['server/index.mjs'], { cwd: process.cwd(), env: { ...process.env, PORT: String(value), CORAGENTIC_DB: path, OPENROUTER_API_KEY: '', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not start')), 3_000);
    child.stdout.on('data', (chunk) => { if (String(chunk).includes('listening')) { clearTimeout(timer); resolve(); } });
    child.once('error', reject);
    child.once('exit', (code) => reject(new Error(`server exited ${code}`)));
  });
  return { child, base: `http://127.0.0.1:${value}` };
}

async function stop(child) { child.kill(); await new Promise((resolve) => child.once('exit', resolve)); }
async function request(base, body, authorized = true) {
  const response = await fetch(`${base}/v1/swarm/runs`, { method: 'POST', headers: { 'content-type': 'application/json', ...(authorized ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}

test('authenticated owner creates a bounded durable declared-worker swarm run', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'coragentic-swarm-api-'));
  const path = join(dir, 'db.sqlite'); seed(path);
  const { child, base } = await start(path);
  try {
    const payload = { goal: 'deploy safely', context: { agentId: 'agent-a', query: 'deployment' }, workers: [{ id: 'worker-a', capabilities: ['deploy'] }] };
    assert.equal((await request(base, payload, false)).status, 401);
    assert.equal((await request(base, { ...payload, context: { agentId: 'agent-a', query: 'deployment', rawDatabaseDump: 'never' } })).status, 400);
    assert.equal((await request(base, { ...payload, context: { agentId: 'agent-b', query: 'deployment' } })).status, 403);
    const created = await request(base, payload);
    assert.equal(created.status, 201);
    assert.equal(created.body.ok, true);
    assert.equal(created.body.data.decisionProvider, 'offline');
    assert.equal(created.body.data.status, 'rejected');
    assert.equal(JSON.stringify(created.body.data).includes('private deploy instruction'), false);
    const fetched = await fetch(`${base}/v1/swarm/${created.body.data.id}`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(fetched.status, 200);
    const run = (await fetched.json()).data;
    assert.equal(run.steps.length, 1);
    assert.equal(run.steps[0].input.worker.id, 'worker-a');
    assert.equal(JSON.stringify(run).includes('private deploy instruction'), false);
    const db = openDatabase(path);
    assert.equal(db.prepare("SELECT count(*) AS n FROM audit_events WHERE entity_type = 'swarm' AND entity_id = ?").get(run.id).n >= 3, true);
    db.close();
  } finally { await stop(child); rmSync(dir, { recursive: true, force: true }); }
});

test('decisionProvider on the run response reflects the ACTUAL provider that answered, not a boot-time guess', async () => {
  // A live-configured key that always fails/malformed-responds must report 'offline'
  // on the run, never a misleading 'configured-with-offline-fallback' placeholder —
  // regression test for the real bug found manually: the API previously hardcoded
  // decisionProvider from whether an env var was merely set, not from what actually
  // answered each decision call.
  const dir = mkdtempSync(join(tmpdir(), 'coragentic-swarm-provider-'));
  const path = join(dir, 'db.sqlite'); seed(path);
  const mockServer = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => { res.writeHead(500); res.end('provider down'); });
  });
  await new Promise((resolve) => mockServer.listen(0, resolve));
  const mockPort = mockServer.address().port;
  const { child, base } = await start(path, {
    OPENROUTER_API_KEY: 'sk-or-fake-for-test',
    CORAGENTIC_JEV_DECISIONS_URL: `http://127.0.0.1:${mockPort}/decisions`,
  });
  try {
    const payload = { goal: 'deploy safely', context: { agentId: 'agent-a', query: 'deployment' }, workers: [{ id: 'worker-a', capabilities: ['deploy'] }] };
    const created = await request(base, payload);
    assert.equal(created.status, 201);
    // Even though a key was "configured", every actual decision failed, so the
    // reported provider must honestly be 'offline' — not a fabricated claim of
    // partial Jev involvement.
    assert.equal(created.body.data.decisionProvider, 'offline');
  } finally { await stop(child); mockServer.close(); rmSync(dir, { recursive: true, force: true }); }
});
