import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { privateKeyToAccount } from 'viem/accounts';
import { signTypedData } from 'viem/actions';
import { http as viemHttp } from 'viem';
import { openDatabase } from './db.mjs';
import { USDG_ADDRESS, CHAIN_ID } from './x402-facilitator.mjs';

const seller = '0x1111111111111111111111111111111111111111';
const token = 'test-session-token';
const stamp = '2026-01-01T00:00:00.000Z';
const hash = (value) => createHash('sha256').update(value).digest('hex');
const payer = privateKeyToAccount('0xb5be4998bcd7a25bcf529cc90e17e6a152d44f1199e5bc33a07e98fb99db48b7'.slice(0, 66));

async function port() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, resolve));
  const value = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return value;
}

function seed(path) {
  const db = openDatabase(path);
  db.prepare('INSERT INTO sessions VALUES (?, ?, ?)').run(hash(token), seller, Date.now() + 60_000);
  db.prepare('INSERT INTO agents VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run('agent-a', seller, 'agent-a', 'test agent', null, '[]', '[]', '[]', 0, 'draft', stamp, stamp);
  db.prepare(`INSERT INTO offerings (id, agent_id, owner_wallet, name, description, price_atomic, asset, network, requirements_json, deliverables_json, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run('offering-a', 'agent-a', seller, 'Test offering', 'A test offering', '1000000', USDG_ADDRESS, 'eip155:4663', '{}', '{}', 'active', stamp, stamp);
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

async function signAuthorization({ value, validAfter, validBefore, nonce, to }) {
  const signature = await signTypedData({ account: payer, chain: undefined, transport: viemHttp() }, {
    account: payer,
    domain: { name: 'Global Dollar', version: '1', chainId: CHAIN_ID, verifyingContract: USDG_ADDRESS },
    types: { TransferWithAuthorization: [
      { name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' },
      { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' },
    ] },
    primaryType: 'TransferWithAuthorization',
    message: { from: payer.address, to, value: BigInt(value), validAfter: BigInt(validAfter), validBefore: BigInt(validBefore), nonce },
  });
  return { from: payer.address, to, value: String(value), validAfter, validBefore, nonce, signature };
}

function encodeX402Signature(authorization) {
  const payload = { x402Version: 2, scheme: 'exact', network: 'eip155:4663', payload: { nonce: authorization.nonce, expiresAt: authorization.validBefore * 1000, authorization } };
  return Buffer.from(JSON.stringify(payload)).toString('base64');
}

test('payment-required reports live verification is available (not unavailable_until_facilitator_configured)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'coragentic-x402-'));
  const path = join(dir, 'db.sqlite'); seed(path);
  const { child, base } = await start(path);
  try {
    const res = await fetch(`${base}/v1/offerings/offering-a/payment-required`);
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.data.settlement, 'verify_available_settlement_requires_relayer');
    assert.equal(body.data.accepts[0].asset, USDG_ADDRESS);
    assert.equal(body.data.accepts[0].payTo, seller);
  } finally { await stop(child); rmSync(dir, { recursive: true, force: true }); }
});

test('verify-payment verifies a real EIP-3009 authorization end-to-end through the live HTTP route', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'coragentic-x402-verify-'));
  const path = join(dir, 'db.sqlite'); seed(path);
  const { child, base } = await start(path);
  try {
    const nowSec = Math.floor(Date.now() / 1000);
    const nonce = `0x${'ab'.repeat(32)}`;
    const authorization = await signAuthorization({ value: '1000000', validAfter: nowSec - 60, validBefore: nowSec + 300, nonce, to: seller });
    const signature = encodeX402Signature(authorization);

    const res = await fetch(`${base}/v1/offerings/offering-a/verify-payment`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ signature }),
    });
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.data.status, 'verified');
    assert.equal(body.data.payer.toLowerCase(), payer.address.toLowerCase());
  } finally { await stop(child); rmSync(dir, { recursive: true, force: true }); }
});

test('verify-payment rejects a payment for the wrong offering amount/payTo, never fakes a pass', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'coragentic-x402-reject-'));
  const path = join(dir, 'db.sqlite'); seed(path);
  const { child, base } = await start(path);
  try {
    const nowSec = Math.floor(Date.now() / 1000);
    const nonce = `0x${'cd'.repeat(32)}`;
    // signed to a DIFFERENT recipient than the offering's owner_wallet
    const authorization = await signAuthorization({ value: '1000000', validAfter: nowSec - 60, validBefore: nowSec + 300, nonce, to: '0x0000000000000000000000000000000000000099' });
    const signature = encodeX402Signature(authorization);

    const res = await fetch(`${base}/v1/offerings/offering-a/verify-payment`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ signature }),
    });
    const body = await res.json();
    assert.equal(res.status, 402);
    assert.equal(body.ok, false);
    assert.equal(body.data.status, 'invalid');
    assert.equal(body.data.reason, 'payto_mismatch');
  } finally { await stop(child); rmSync(dir, { recursive: true, force: true }); }
});
