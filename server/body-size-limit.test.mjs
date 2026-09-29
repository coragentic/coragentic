import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';

async function port() { const server = createServer(); await new Promise((resolve) => server.listen(0, resolve)); const value = server.address().port; await new Promise((resolve) => server.close(resolve)); return value; }
async function start(path) { const p = await port(); const child = spawn(process.execPath, ['server/index.mjs'], { cwd: process.cwd(), env: { ...process.env, PORT: String(p), CORAGENTIC_DB: path }, stdio: ['ignore', 'pipe', 'pipe'] }); await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('server did not start')), 3000); child.stdout.on('data', (chunk) => { if (String(chunk).includes('listening')) { clearTimeout(timer); resolve(); } }); child.once('error', reject); }); return { child, base: `http://127.0.0.1:${p}` }; }
async function stop(child) { child.kill(); await new Promise((resolve) => child.once('exit', resolve)); }

test('oversized request bodies are rejected without buffering the full payload in application memory', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'coragentic-bodysize-')); const path = join(dir, 'db.sqlite'); const { child, base } = await start(path);
  try {
    // 2MB body against a 256KB ceiling -- if the server ever accepts this and
    // tries to JSON.parse() it, that's the old unbounded-buffering behavior.
    const oversized = JSON.stringify({ wallet: '0x' + '11'.repeat(20), padding: 'x'.repeat(2 * 1024 * 1024) });
    const res = await fetch(`${base}/v1/auth/challenge`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: oversized });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.ok, false);
  } finally { await stop(child); rmSync(dir, { recursive: true, force: true }); }
});
