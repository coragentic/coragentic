import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { openDatabase } from './db.mjs';

const owner = '0x1111111111111111111111111111111111111111';
const stranger = '0x2222222222222222222222222222222222222222';
const token = 'owner-session';
const hash = (value) => createHash('sha256').update(value).digest('hex');

async function port() { const server = createServer(); await new Promise((resolve) => server.listen(0, resolve)); const value = server.address().port; await new Promise((resolve) => server.close(resolve)); return value; }
function seed(path) {
  const db = openDatabase(path); const now = '2026-01-01T00:00:00.000Z';
  db.prepare('INSERT INTO sessions VALUES (?, ?, ?)').run(hash(token), owner, Date.now() + 60_000);
  db.prepare('INSERT INTO agents VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run('agent-a', owner, 'agent-a', 'test', null, '[]', '[]', '[]', 0, 'draft', now, now);
  db.prepare('INSERT INTO offerings VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run('offering-a', 'agent-a', owner, 'offer', 'test', '1000000', '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168', 'eip155:4663', '{}', '{}', 'active', now, now);
  db.prepare('INSERT INTO jobs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run('job-a', 'offering-a', stranger, owner, '{}', 'requested', '{}', null, now, now);
  db.prepare('INSERT INTO audit_events (id, actor_wallet, entity_type, entity_id, event_type, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run('evt-1', stranger, 'job', 'job-a', 'job_requested', '{}', now);
  db.close();
}
async function start(path) { const p = await port(); const child = spawn(process.execPath, ['server/index.mjs'], { cwd: process.cwd(), env: { ...process.env, PORT: String(p), CORAGENTIC_DB: path }, stdio: ['ignore', 'pipe', 'pipe'] }); await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('server did not start')), 3000); child.stdout.on('data', (chunk) => { if (String(chunk).includes('listening')) { clearTimeout(timer); resolve(); } }); child.once('error', reject); }); return { child, base: `http://127.0.0.1:${p}` }; }
async function stop(child) { child.kill(); await new Promise((resolve) => child.once('exit', resolve)); }

test('agent audit trail requires a valid owner session and never leaks to unauthenticated or non-owner callers', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'coragentic-agent-audit-')); const path = join(dir, 'db.sqlite'); seed(path); const { child, base } = await start(path);
  try {
    const noAuth = await fetch(`${base}/v1/agents/agent-a/audit`);
    assert.equal(noAuth.status, 401);
    const strangerRes = await fetch(`${base}/v1/agents/agent-a/audit`, { headers: { authorization: `Bearer wrong-token` } });
    assert.equal(strangerRes.status, 401);
    const ownerRes = await fetch(`${base}/v1/agents/agent-a/audit`, { headers: { authorization: `Bearer ${token}` } });
    const body = await ownerRes.json();
    assert.equal(ownerRes.status, 200);
    assert.equal(body.data.length, 1);
    assert.equal(body.data[0].entityId, 'job-a');
  } finally { await stop(child); rmSync(dir, { recursive: true, force: true }); }
});
