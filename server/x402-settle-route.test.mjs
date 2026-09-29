import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { openDatabase } from './db.mjs';
import { USDG_ADDRESS } from './x402-onchain-verifier.mjs';

const seller = '0x1111111111111111111111111111111111111111';
const payer = '0x3333333333333333333333333333333333333333';
const stamp = '2026-01-01T00:00:00.000Z';
const hash = (value) => createHash('sha256').update(value).digest('hex');
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

async function port() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, resolve));
  const value = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return value;
}

function seed(path) {
  const db = openDatabase(path);
  db.prepare('INSERT INTO agents VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run('agent-a', seller, 'agent-a', 'test agent', null, '[]', '[]', '[]', 0, 'draft', stamp, stamp);
  db.prepare(`INSERT INTO offerings (id, agent_id, owner_wallet, name, description, price_atomic, asset, network, requirements_json, deliverables_json, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run('offering-a', 'agent-a', seller, 'Test offering', 'A test offering', '1000000', USDG_ADDRESS, 'eip155:4663', '{}', '{}', 'active', stamp, stamp);
  db.prepare('INSERT INTO jobs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run('job-a', 'offering-a', payer, seller, '{}', 'requested', '{"status":"unpaid"}', null, stamp, stamp);
  db.close();
}

// This test spawns the real server process pointed at a mock RPC HTTP server that
// returns a canned transaction receipt, so the full route (DB lookup, requirement
// construction, on-chain verification, replay-guard insert, audit event) is exercised
// exactly as it runs in production — only the RPC transport is faked.
async function startMockRpc(receiptForHash, { blockNumber = '0x3ec' } = {}) {
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const parsed = JSON.parse(body);
      if (parsed.method === 'eth_chainId') {
        res.end(JSON.stringify({ jsonrpc: '2.0', id: parsed.id, result: '0x1237' }));
        return;
      }
      if (parsed.method === 'eth_blockNumber') {
        // Comfortably ahead of the receipt's block so the confirmation-depth
        // check in x402-onchain-verifier.mjs passes with room to spare.
        res.end(JSON.stringify({ jsonrpc: '2.0', id: parsed.id, result: blockNumber }));
        return;
      }
      if (parsed.method === 'eth_getTransactionReceipt') {
        const [txHash] = parsed.params;
        const receipt = receiptForHash(txHash);
        res.end(JSON.stringify({ jsonrpc: '2.0', id: parsed.id, result: receipt }));
        return;
      }
      res.end(JSON.stringify({ jsonrpc: '2.0', id: parsed.id, result: null }));
    });
  });
  await new Promise((resolve) => server.listen(0, resolve));
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}

function pad32(addr) { return `0x${'0'.repeat(24)}${addr.slice(2)}`; }

async function start(path, rpcUrl) {
  const value = await port();
  const child = spawn(process.execPath, ['server/index.mjs'], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(value), CORAGENTIC_DB: path, OPENROUTER_API_KEY: '', ROBINHOOD_RPC_URL: rpcUrl },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not start')), 3_000);
    child.stdout.on('data', (chunk) => { if (String(chunk).includes('listening')) { clearTimeout(timer); resolve(); } });
    child.once('error', reject);
    child.once('exit', (code) => reject(new Error(`server exited ${code}`)));
  });
  return { child, base: `http://127.0.0.1:${value}` };
}

async function stop(child) { child.kill(); await new Promise((resolve) => child.once('exit', resolve)); }

test('settle verifies a real successful transfer receipt and records it, then rejects replay', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'coragentic-settle-'));
  const path = join(dir, 'db.sqlite'); seed(path);
  const txHash = `0x${'aa'.repeat(32)}`;
  const receipt = {
    status: '0x1', blockNumber: '0x3e8',
    logs: [{ address: USDG_ADDRESS, topics: [TRANSFER_TOPIC, pad32(payer), pad32(seller)], data: `0x${(1_000_000n).toString(16)}` }],
  };
  const { server: rpcServer, url: rpcUrl } = await startMockRpc(() => receipt);
  const { child, base } = await start(path, rpcUrl);
  try {
    const first = await fetch(`${base}/v1/offerings/offering-a/settle`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ txHash, jobId: 'job-a' }),
    });
    const firstBody = await first.json();
    assert.equal(first.status, 200);
    assert.equal(firstBody.ok, true);
    assert.equal(firstBody.data.status, 'settled');
    assert.equal(firstBody.data.txHash, txHash);
    assert.equal(firstBody.data.payer.toLowerCase(), payer.toLowerCase());

    // Replay: the exact same tx hash must be rejected the second time.
    const second = await fetch(`${base}/v1/offerings/offering-a/settle`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ txHash, jobId: 'job-a' }),
    });
    const secondBody = await second.json();
    assert.equal(second.status, 409);
    assert.equal(secondBody.error, 'transaction_already_settled');
  } finally { await stop(child); rpcServer.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('settle rejects an underpaying transaction and never records it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'coragentic-settle-under-'));
  const path = join(dir, 'db.sqlite'); seed(path);
  const txHash = `0x${'bb'.repeat(32)}`;
  const receipt = {
    status: '0x1', blockNumber: '0x3e8',
    logs: [{ address: USDG_ADDRESS, topics: [TRANSFER_TOPIC, pad32(payer), pad32(seller)], data: `0x${(500_000n).toString(16)}` }],
  };
  const { server: rpcServer, url: rpcUrl } = await startMockRpc(() => receipt);
  const { child, base } = await start(path, rpcUrl);
  try {
    const res = await fetch(`${base}/v1/offerings/offering-a/settle`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ txHash, jobId: 'job-a' }),
    });
    const body = await res.json();
    assert.equal(res.status, 402);
    assert.equal(body.ok, false);
    assert.equal(body.data.reason, 'no_matching_transfer_log');
  } finally { await stop(child); rpcServer.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('a settled transfer is bound to one specific job and cannot be claimed for a second job at the same offering/price', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'coragentic-settle-jobbind-'));
  const path = join(dir, 'db.sqlite');
  const db = openDatabase(path);
  db.prepare('INSERT INTO agents VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run('agent-a', seller, 'agent-a', 'test agent', null, '[]', '[]', '[]', 0, 'draft', stamp, stamp);
  db.prepare(`INSERT INTO offerings (id, agent_id, owner_wallet, name, description, price_atomic, asset, network, requirements_json, deliverables_json, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run('offering-a', 'agent-a', seller, 'Test offering', 'A test offering', '1000000', USDG_ADDRESS, 'eip155:4663', '{}', '{}', 'active', stamp, stamp);
  // Two separate jobs against the SAME offering (same price/asset/seller) --
  // this is exactly the shape that lets one observed transfer be replayed
  // across unrelated jobs if settlement isn't bound to a specific job.
  db.prepare('INSERT INTO jobs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run('job-1', 'offering-a', payer, seller, '{}', 'requested', '{"status":"unpaid"}', null, stamp, stamp);
  db.prepare('INSERT INTO jobs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run('job-2', 'offering-a', payer, seller, '{}', 'requested', '{"status":"unpaid"}', null, stamp, stamp);
  db.close();

  const txHash = `0x${'cc'.repeat(32)}`;
  const receipt = { status: '0x1', blockNumber: '0x3e8', logs: [{ address: USDG_ADDRESS, topics: [TRANSFER_TOPIC, pad32(payer), pad32(seller)], data: `0x${(1_000_000n).toString(16)}` }] };
  const { server: rpcServer, url: rpcUrl } = await startMockRpc(() => receipt);
  const { child, base } = await start(path, rpcUrl);
  try {
    // Settle for job-1 -- must succeed and mark job-1 paid.
    const first = await fetch(`${base}/v1/offerings/offering-a/settle`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ txHash, jobId: 'job-1' }),
    });
    const firstBody = await first.json();
    assert.equal(first.status, 200);
    assert.equal(firstBody.data.jobId, 'job-1');

    // Attempting to attribute the SAME transfer to job-2 must be rejected --
    // this is the cross-job/order-attribution vulnerability.
    const second = await fetch(`${base}/v1/offerings/offering-a/settle`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ txHash, jobId: 'job-2' }),
    });
    const secondBody = await second.json();
    assert.equal(second.status, 409);
    assert.equal(secondBody.error, 'transaction_already_settled');

    const jobsDb = openDatabase(path);
    const job1 = jobsDb.prepare('SELECT payment_json FROM jobs WHERE id = ?').get('job-1');
    const job2 = jobsDb.prepare('SELECT payment_json FROM jobs WHERE id = ?').get('job-2');
    jobsDb.close();
    assert.equal(JSON.parse(job1.payment_json).status, 'settled');
    assert.equal(JSON.parse(job2.payment_json).status, 'unpaid');
  } finally { await stop(child); rpcServer.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('settle without a jobId is rejected -- payment must be bound to a specific job', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'coragentic-settle-nojobid-'));
  const path = join(dir, 'db.sqlite'); seed(path);
  const txHash = `0x${'dd'.repeat(32)}`;
  const receipt = { status: '0x1', blockNumber: '0x3e8', logs: [{ address: USDG_ADDRESS, topics: [TRANSFER_TOPIC, pad32(payer), pad32(seller)], data: `0x${(1_000_000n).toString(16)}` }] };
  const { server: rpcServer, url: rpcUrl } = await startMockRpc(() => receipt);
  const { child, base } = await start(path, rpcUrl);
  try {
    const res = await fetch(`${base}/v1/offerings/offering-a/settle`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ txHash }),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error, 'job_id_required');
  } finally { await stop(child); rpcServer.close(); rmSync(dir, { recursive: true, force: true }); }
});
