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
function seed(path, paymentJson) {
  const db = openDatabase(path); const now = '2026-01-01T00:00:00.000Z';
  db.prepare('INSERT INTO sessions VALUES (?, ?, ?)').run(hash(buyerToken), buyer, Date.now() + 60_000);
  db.prepare('INSERT INTO sessions VALUES (?, ?, ?)').run(hash(sellerToken), seller, Date.now() + 60_000);
  db.prepare('INSERT INTO agents VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run('agent-a', seller, 'agent-a', 'test', null, '[]', '[]', '[]', 0, 'draft', now, now);
  db.prepare('INSERT INTO offerings VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run('offering-a', 'agent-a', seller, 'offer', 'test', '1000000', '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168', 'eip155:4663', '{}', '{}', 'active', now, now);
  db.prepare('INSERT INTO jobs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run('job-a', 'offering-a', buyer, seller, '{}', 'requested', paymentJson, null, now, now);
  db.close();
}
async function start(path) { const p = await port(); const child = spawn(process.execPath, ['server/index.mjs'], { cwd: process.cwd(), env: { ...process.env, PORT: String(p), CORAGENTIC_DB: path }, stdio: ['ignore', 'pipe', 'pipe'] }); await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('server did not start')), 3000); child.stdout.on('data', (chunk) => { if (String(chunk).includes('listening')) { clearTimeout(timer); resolve(); } }); child.once('error', reject); }); return { child, base: `http://127.0.0.1:${p}` }; }
async function stop(child) { child.kill(); await new Promise((resolve) => child.once('exit', resolve)); }

test('seller cannot accept (and thus route to worker execution) an unpaid job', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'coragentic-job-unpaid-')); const path = join(dir, 'db.sqlite'); seed(path, JSON.stringify({ status: 'unpaid' })); const { child, base } = await start(path);
  try {
    const res = await fetch(`${base}/v1/jobs/job-a/status`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${sellerToken}` }, body: JSON.stringify({ status: 'accepted' }) });
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.equal(body.error, 'payment_not_settled');
  } finally { await stop(child); rmSync(dir, { recursive: true, force: true }); }
});

test('seller can accept a job once payment is settled', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'coragentic-job-paid-')); const path = join(dir, 'db.sqlite'); seed(path, JSON.stringify({ status: 'settled', txHash: '0xabc' })); const { child, base } = await start(path);
  try {
    const res = await fetch(`${base}/v1/jobs/job-a/status`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${sellerToken}` }, body: JSON.stringify({ status: 'accepted' }) });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.status, 'accepted');
  } finally { await stop(child); rmSync(dir, { recursive: true, force: true }); }
});
