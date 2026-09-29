import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { openDatabase } from './db.mjs';

// GET /v1/session lets the frontend cheaply verify a STORED bearer token is
// still accepted by the API on mount. Before this route existed, the
// frontend's "restore session" check called the public GET /v1/agents route
// instead -- which returns 200 regardless of the Authorization header, so a
// stale/expired/garbage token was never actually detected. The UI would then
// render "Private workspace enabled" while every real private route (Proof,
// Swarms, Context) 401'd with a dead-end error card and no way back to a
// working sign-in screen.
const owner = '0x1111111111111111111111111111111111111111';
const token = 'owner-session';
const hash = (value) => createHash('sha256').update(value).digest('hex');

async function port() { const server = createServer(); await new Promise((resolve) => server.listen(0, resolve)); const value = server.address().port; await new Promise((resolve) => server.close(resolve)); return value; }
function seed(path) {
  const db = openDatabase(path);
  db.prepare('INSERT INTO sessions VALUES (?, ?, ?)').run(hash(token), owner, Date.now() + 60_000);
  db.close();
}
async function start(path) { const p = await port(); const child = spawn(process.execPath, ['server/index.mjs'], { cwd: process.cwd(), env: { ...process.env, PORT: String(p), CORAGENTIC_DB: path }, stdio: ['ignore', 'pipe', 'pipe'] }); await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('server did not start')), 3000); child.stdout.on('data', (chunk) => { if (String(chunk).includes('listening')) { clearTimeout(timer); resolve(); } }); child.once('error', reject); }); return { child, base: `http://127.0.0.1:${p}` }; }
async function stop(child) { child.kill(); await new Promise((resolve) => child.once('exit', resolve)); }

test('GET /v1/session requires a real, currently-valid session token', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'coragentic-session-whoami-')); const path = join(dir, 'db.sqlite'); seed(path); const { child, base } = await start(path);
  try {
    const noAuth = await fetch(`${base}/v1/session`);
    assert.equal(noAuth.status, 401);

    const bogus = await fetch(`${base}/v1/session`, { headers: { authorization: `Bearer not-a-real-token` } });
    assert.equal(bogus.status, 401);

    const ok = await fetch(`${base}/v1/session`, { headers: { authorization: `Bearer ${token}` } });
    const body = await ok.json();
    assert.equal(ok.status, 200);
    assert.equal(body.data.wallet, owner);
  } finally { await stop(child); rmSync(dir, { recursive: true, force: true }); }
});
