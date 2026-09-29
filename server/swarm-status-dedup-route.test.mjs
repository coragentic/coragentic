import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { openDatabase } from './db.mjs';
import { migrateSwarmSchema } from './swarm.mjs';

// GET /v1/swarm/status joined swarm_runs to audit_events on (entity_type,
// entity_id, actor_wallet) WITHOUT deduplicating -- so a run with N audit
// events for that wallet (every real run has multiple: created, step
// updates, completed/rejected) came back as N duplicate rows. Reported live:
// a single swarm run rendered as 7 identical "Swarm run ... REJECTED" cards.
const owner = '0x1111111111111111111111111111111111111111';
const token = 'owner-session';
const hash = (value) => createHash('sha256').update(value).digest('hex');

async function port() { const server = createServer(); await new Promise((resolve) => server.listen(0, resolve)); const value = server.address().port; await new Promise((resolve) => server.close(resolve)); return value; }
function seed(path) {
  const db = openDatabase(path);
  migrateSwarmSchema(db);
  db.prepare('INSERT INTO sessions VALUES (?, ?, ?)').run(hash(token), owner, Date.now() + 60_000);
  const now = '2026-01-01T00:00:00.000Z';
  const runId = randomUUID();
  db.prepare('INSERT INTO swarm_runs (id, goal, status, shared_evidence_json, threshold, human_escalation, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(runId, 'test goal', 'rejected', '{}', 0.5, null, now, now);
  // A real run accumulates multiple audit events for the same actor wallet
  // (created, step updates, final decision) -- seed several to reproduce.
  for (const eventType of ['swarm_run_created', 'swarm_step_updated', 'swarm_step_updated', 'swarm_run_updated']) {
    db.prepare('INSERT INTO audit_events (id, actor_wallet, entity_type, entity_id, event_type, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(randomUUID(), owner, 'swarm', runId, eventType, '{}', now);
  }
  db.close();
  return runId;
}
async function start(path) { const p = await port(); const child = spawn(process.execPath, ['server/index.mjs'], { cwd: process.cwd(), env: { ...process.env, PORT: String(p), CORAGENTIC_DB: path }, stdio: ['ignore', 'pipe', 'pipe'] }); await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('server did not start')), 3000); child.stdout.on('data', (chunk) => { if (String(chunk).includes('listening')) { clearTimeout(timer); resolve(); } }); child.once('error', reject); }); return { child, base: `http://127.0.0.1:${p}` }; }
async function stop(child) { child.kill(); await new Promise((resolve) => child.once('exit', resolve)); }

test('GET /v1/swarm/status returns each run exactly once, even with many audit events', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'coragentic-swarm-status-')); const path = join(dir, 'db.sqlite'); const runId = seed(path); const { child, base } = await start(path);
  try {
    const res = await fetch(`${base}/v1/swarm/status`, { headers: { authorization: `Bearer ${token}` } });
    const body = await res.json();
    assert.equal(res.status, 200);
    const matching = body.data.filter((row) => row.id === runId);
    assert.equal(matching.length, 1, `expected exactly 1 row for run ${runId}, got ${matching.length}`);
  } finally { await stop(child); rmSync(dir, { recursive: true, force: true }); }
});
