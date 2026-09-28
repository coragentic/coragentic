import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import {
  migrateWorkerSchema,
  claimNextJob,
  casTransition,
  processJob,
} from './worker.mjs';

const schema = (db) => db.exec(`
  CREATE TABLE jobs (
    id TEXT PRIMARY KEY,
    offering_id TEXT NOT NULL,
    buyer_wallet TEXT NOT NULL,
    seller_wallet TEXT NOT NULL,
    requirements_json TEXT NOT NULL,
    status TEXT NOT NULL,
    payment_json TEXT NOT NULL,
    deliverable_json TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`);

const addJob = (db, id = 'job-1', status = 'accepted') => db.prepare(`
  INSERT INTO jobs (id, offering_id, buyer_wallet, seller_wallet, requirements_json,
    status, payment_json, deliverable_json, created_at, updated_at)
  VALUES (?, 'offering-1', 'buyer', 'seller', '{}', ?, '{"status":"unpaid"}', NULL, '2026-01-01', '2026-01-01')
`).run(id, status);

function tempDb() {
  const dir = mkdtempSync(join(tmpdir(), 'coragentic-worker-'));
  const path = join(dir, 'worker.sqlite');
  const db = new DatabaseSync(path);
  schema(db);
  migrateWorkerSchema(db);
  return { dir, path, db };
}

test('migration adds durable lease and attempt columns', () => {
  const { db, dir } = tempDb();
  try {
    const columns = db.prepare('PRAGMA table_info(jobs)').all().map((row) => row.name);
    assert.deepEqual(columns.slice(-4), ['lease_owner', 'lease_until', 'attempts', 'last_error']);
    migrateWorkerSchema(db);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM pragma_table_info(\'jobs\') WHERE name = \'attempts\'').get().count, 1);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('two workers atomically claim one job', () => {
  const { path, db, dir } = tempDb();
  const second = new DatabaseSync(path);
  try {
    addJob(db);
    const firstClaim = claimNextJob(db, 'worker-a');
    const secondClaim = claimNextJob(second, 'worker-b');
    assert.equal(firstClaim?.id, 'job-1');
    assert.equal(secondClaim, null);
    assert.equal(db.prepare('SELECT lease_owner, attempts FROM jobs WHERE id = ?').get('job-1').attempts, 1);
  } finally { second.close(); db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('CAS transition requires the current lease and preserves payment state', () => {
  const { db, dir } = tempDb();
  try {
    addJob(db);
    const claimed = claimNextJob(db, 'worker-a');
    assert.equal(casTransition(db, claimed, 'submitted', { deliverable: { answer: 42 } }), true);
    const row = db.prepare('SELECT status, deliverable_json, payment_json, lease_owner FROM jobs WHERE id = ?').get('job-1');
    assert.equal(row.status, 'submitted');
    assert.deepEqual(JSON.parse(row.deliverable_json), { answer: 42 });
    assert.deepEqual(JSON.parse(row.payment_json), { status: 'unpaid' });
    assert.equal(row.lease_owner, null);
    assert.equal(casTransition(db, claimed, 'completed'), false);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('processJob retries failures and marks a job failed at the bound', async () => {
  const { db, dir } = tempDb();
  try {
    addJob(db);
    const executor = async () => { throw new Error('executor unavailable'); };
    const first = await processJob(db, executor, { workerId: 'worker-a', maxAttempts: 2 });
    assert.equal(first.outcome, 'retry');
    const second = await processJob(db, executor, { workerId: 'worker-a', maxAttempts: 2 });
    assert.equal(second.outcome, 'failed');
    const row = db.prepare('SELECT status, attempts, last_error, payment_json FROM jobs WHERE id = ?').get('job-1');
    assert.equal(row.status, 'failed');
    assert.equal(row.attempts, 2);
    assert.equal(row.last_error, 'executor unavailable');
    assert.deepEqual(JSON.parse(row.payment_json), { status: 'unpaid' });
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('processJob submits executor output without settling payment', async () => {
  const { db, dir } = tempDb();
  try {
    addJob(db);
    const result = await processJob(db, async (job) => ({ ok: true, jobId: job.id }), { workerId: 'worker-a' });
    assert.equal(result.outcome, 'submitted');
    const row = db.prepare('SELECT status, deliverable_json, payment_json FROM jobs WHERE id = ?').get('job-1');
    assert.equal(row.status, 'submitted');
    assert.deepEqual(JSON.parse(row.deliverable_json), { ok: true, jobId: 'job-1' });
    assert.deepEqual(JSON.parse(row.payment_json), { status: 'unpaid' });
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});
