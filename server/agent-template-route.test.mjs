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
const token = 'template-owner-session';
const hash = (value) => createHash('sha256').update(value).digest('hex');
async function port() { const s = createServer(); await new Promise((r) => s.listen(0, r)); const p = s.address().port; await new Promise((r) => s.close(r)); return p; }
function seed(path) { const db = openDatabase(path); db.prepare('INSERT INTO sessions VALUES (?, ?, ?)').run(hash(token), owner, Date.now() + 60_000); db.close(); }
async function start(path) { const p = await port(); const child = spawn(process.execPath, ['server/index.mjs'], { cwd: process.cwd(), env: { ...process.env, PORT: String(p), CORAGENTIC_DB: path }, stdio: ['ignore', 'pipe', 'pipe'] }); await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('server did not start')), 3000); child.stdout.on('data', (c) => { if (String(c).includes('listening')) { clearTimeout(timer); resolve(); } }); child.once('error', reject); }); return { child, base: `http://127.0.0.1:${p}` }; }
async function stop(child) { child.kill(); await new Promise((r) => child.once('exit', r)); }

test('creating a templated agent seeds its starter vault instead of an empty workspace', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'coragentic-agent-template-')); const path = join(dir, 'db.sqlite'); seed(path); const { child, base } = await start(path);
  try {
    const created = await fetch(`${base}/v1/agents`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Atlas', description: 'Research payment systems', template: 'research' }) });
    const body = await created.json();
    assert.equal(created.status, 201);
    assert.equal(body.data.template, 'research');
    assert.deepEqual(body.data.capabilities, ['context', 'analysis', 'research']);
    const memory = await fetch(`${base}/v1/agents/${body.data.id}/memory`, { headers: { authorization: `Bearer ${token}` } });
    const records = (await memory.json()).data;
    assert.deepEqual(records.map((r) => r.key).sort(), ['first-task', 'mission', 'operating-context']);
  } finally { await stop(child); rmSync(dir, { recursive: true, force: true }); }
});

test('creating an agent rejects unknown templates', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'coragentic-agent-template-')); const path = join(dir, 'db.sqlite'); seed(path); const { child, base } = await start(path);
  try {
    const res = await fetch(`${base}/v1/agents`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Atlas', description: 'Research payment systems', template: 'fake' }) });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, 'invalid_agent_template');
  } finally { await stop(child); rmSync(dir, { recursive: true, force: true }); }
});
