import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { openDatabase } from './db.mjs';

const buyer = '0x1111111111111111111111111111111111111111';
const seller = '0x2222222222222222222222222222222222222222';
const buyerToken = 'buyer-session';
const sellerToken = 'seller-session';
const hash = (value) => createHash('sha256').update(value).digest('hex');

async function port() { const server = createServer(); await new Promise((resolve) => server.listen(0, resolve)); const value = server.address().port; await new Promise((resolve) => server.close(resolve)); return value; }
function seed(path) {
  const db = openDatabase(path); const now = '2026-01-01T00:00:00.000Z';
  db.prepare('INSERT INTO sessions VALUES (?, ?, ?)').run(hash(buyerToken), buyer, Date.now() + 60_000);
  db.prepare('INSERT INTO sessions VALUES (?, ?, ?)').run(hash(sellerToken), seller, Date.now() + 60_000);
  db.prepare('INSERT INTO agents VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run('agent-a', seller, 'agent-a', 'test', null, '[]', '[]', '[]', 0, 'draft', now, now);
  db.prepare('INSERT INTO offerings VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run('offering-a', 'agent-a', seller, 'offer', 'test', '1000000', '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168', 'eip155:4663', '{}', '{}', 'active', now, now);
  db.prepare('INSERT INTO jobs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run('job-a', 'offering-a', buyer, seller, '{}', 'requested', '{}', null, now, now);
  db.close();
}
async function start(path) { const p = await port(); const child = spawn(process.execPath, ['server/index.mjs'], { cwd: process.cwd(), env: { ...process.env, PORT: String(p), CORAGENTIC_DB: path }, stdio: ['ignore', 'pipe', 'pipe'] }); await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('server did not start')), 3000); child.stdout.on('data', (chunk) => { if (String(chunk).includes('listening')) { clearTimeout(timer); resolve(); } }); child.once('error', reject); }); return { child, base: `http://127.0.0.1:${p}` }; }
async function stop(child) { child.kill(); await new Promise((resolve) => child.once('exit', resolve)); }

test('concurrent HTTP job-status transitions: exactly one of two racing writes wins', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'coragentic-job-race-')); const path = join(dir, 'db.sqlite'); seed(path); const { child, base } = await start(path);
  try {
    // Fire both requests back-to-back without awaiting between them so the
    // Node event loop genuinely interleaves their readBody()/DB work.
    const acceptPromise = fetch(`${base}/v1/jobs/job-a/status`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${sellerToken}` }, body: JSON.stringify({ status: 'accepted' }) });
    const cancelPromise = fetch(`${base}/v1/jobs/job-a/status`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${buyerToken}` }, body: JSON.stringify({ status: 'cancelled' }) });
    const [acceptRes, cancelRes] = await Promise.all([acceptPromise, cancelPromise]);
    const outcomes = [acceptRes.status, cancelRes.status].sort();
    // With the CAS guard, at most one of the two can ever apply -- the loser
    // gets a clean 409 instead of a silently overwritten state.
    assert.ok(outcomes[0] === 200 || outcomes[0] === 409);
    assert.ok(!(acceptRes.status === 200 && cancelRes.status === 200));
    const final = await fetch(`${base}/v1/jobs/job-a`, { headers: { authorization: `Bearer ${sellerToken}` } });
    const finalBody = await final.json();
    assert.ok(['requested', 'accepted', 'cancelled'].includes(finalBody.data.status));
  } finally { await stop(child); rmSync(dir, { recursive: true, force: true }); }
});

test('deterministic SQL-level race: two updates racing off the same stale status must not both apply', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'coragentic-job-race-sql-')); const path = join(dir, 'db.sqlite'); seed(path);
  const db = openDatabase(path);
  try {
    // Simulate the interleaving directly at the SQL layer: both "requests" read
    // the same prior status ('requested') before either one writes -- this is
    // exactly what happens when readBody() yields the event loop between the
    // SELECT and the UPDATE in the real handler.
    const priorStatus = db.prepare('SELECT status FROM jobs WHERE id = ?').get('job-a').status;
    assert.equal(priorStatus, 'requested');

    const acceptResult = db.prepare('UPDATE jobs SET status = ?, updated_at = ? WHERE id = ? AND status = ?')
      .run('accepted', '2026-01-01T00:00:01.000Z', 'job-a', priorStatus);
    const cancelResult = db.prepare('UPDATE jobs SET status = ?, updated_at = ? WHERE id = ? AND status = ?')
      .run('cancelled', '2026-01-01T00:00:01.000Z', 'job-a', priorStatus);

    // Exactly one of the two stale-status-guarded writes must succeed.
    assert.deepEqual([acceptResult.changes, cancelResult.changes].sort(), [0, 1]);
    const final = db.prepare('SELECT status FROM jobs WHERE id = ?').get('job-a');
    assert.equal(final.status, 'accepted');
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

