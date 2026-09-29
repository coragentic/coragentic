import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { privateKeyToAccount } from 'viem/accounts';
import { signMessage } from 'viem/actions';
import { http as viemHttp } from 'viem';

const account = privateKeyToAccount('0xb5be4998bcd7a25bcf529cc90e17e6a152d44f1199e5bc33a07e98fb99db48b7'.slice(0, 66));

async function port() { const server = createServer(); await new Promise((resolve) => server.listen(0, resolve)); const value = server.address().port; await new Promise((resolve) => server.close(resolve)); return value; }
async function start(path) { const p = await port(); const child = spawn(process.execPath, ['server/index.mjs'], { cwd: process.cwd(), env: { ...process.env, PORT: String(p), CORAGENTIC_DB: path }, stdio: ['ignore', 'pipe', 'pipe'] }); await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('server did not start')), 3000); child.stdout.on('data', (chunk) => { if (String(chunk).includes('listening')) { clearTimeout(timer); resolve(); } }); child.once('error', reject); }); return { child, base: `http://127.0.0.1:${p}` }; }
async function stop(child) { child.kill(); await new Promise((resolve) => child.once('exit', resolve)); }

test('a single wallet challenge can only ever be redeemed once, even under concurrent verify calls', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'coragentic-auth-race-')); const path = join(dir, 'db.sqlite'); const { child, base } = await start(path);
  try {
    const challengeRes = await fetch(`${base}/v1/auth/challenge`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ wallet: account.address }) });
    const challenge = (await challengeRes.json()).data;
    const signature = await signMessage({ account, transport: viemHttp() }, { account, message: challenge.message });

    // Fire two concurrent /verify calls with the SAME nonce+signature.
    const [resA, resB] = await Promise.all([
      fetch(`${base}/v1/auth/verify`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ wallet: account.address, nonce: challenge.nonce, signature }) }),
      fetch(`${base}/v1/auth/verify`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ wallet: account.address, nonce: challenge.nonce, signature }) }),
    ]);
    const [bodyA, bodyB] = await Promise.all([resA.json(), resB.json()]);
    const outcomes = [resA.status, resB.status].sort();
    // Exactly one of the two must mint a session; the other must be rejected
    // as an already-used challenge, never two sessions from one signature.
    assert.deepEqual(outcomes, [200, 401]);
    const tokens = [bodyA, bodyB].filter((b) => b.ok).map((b) => b.data.token);
    assert.equal(tokens.length, 1);
  } finally { await stop(child); rmSync(dir, { recursive: true, force: true }); }
});
