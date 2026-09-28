import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { openDatabase } from './db.mjs';

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
  db.prepare('INSERT INTO sessions VALUES (?, ?, ?)').run(hash(token), wallet, Date.now() + 60_000);
  for (const [id, owner] of [['agent-a', wallet], ['agent-b', other]]) {
    db.prepare('INSERT INTO agents VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, owner, id, 'test agent', null, '[]', '[]', '[]', 0, 'draft', stamp, stamp);
  }
  db.close();
}

async function start(path) {
  const value = await port();
  const child = spawn(process.execPath, ['server/index.mjs'], { cwd: process.cwd(), env: { ...process.env, PORT: String(value), CORAGENTIC_DB: path, OPENROUTER_API_KEY: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not start')), 3_000);
    child.stdout.on('data', (chunk) => { if (String(chunk).includes('listening')) { clearTimeout(timer); resolve(); } });
    child.once('error', reject);
    child.once('exit', (code) => reject(new Error(`server exited ${code}`)));
  });
  return { child, base: `http://127.0.0.1:${value}` };
}

async function stop(child) { child.kill(); await new Promise((resolve) => child.once('exit', resolve)); }

test('registration-call route returns unsigned ERC-8004 register calldata for the owner only', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'coragentic-registration-call-'));
  const path = join(dir, 'db.sqlite'); seed(path);
  const { child, base } = await start(path);
  try {
    // No session -> 401
    const unauth = await fetch(`${base}/v1/agents/agent-a/registration-call`);
    assert.equal(unauth.status, 401);

    // Not owner -> 403
    const notOwner = await fetch(`${base}/v1/agents/agent-b/registration-call`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(notOwner.status, 403);

    // Owner -> 200 with unsigned calldata referencing the real registry address
    const ownerRes = await fetch(`${base}/v1/agents/agent-a/registration-call`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(ownerRes.status, 200);
    const body = await ownerRes.json();
    assert.equal(body.ok, true);
    assert.equal(body.data.chainId, 4663);
    assert.equal(body.data.registry, '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432');
    assert.equal(body.data.to, body.data.registry);
    assert.equal(body.data.unsigned, true);
    assert.equal(body.data.custody, 'external_wallet_required');
    assert.match(body.data.data, /^0x[0-9a-f]+$/);
    assert.match(body.data.warning, /external wallet/);
    // never includes a private key or signature field
    assert.equal('privateKey' in body.data, false);
    assert.equal('signature' in body.data, false);
  } finally { await stop(child); rmSync(dir, { recursive: true, force: true }); }
});
