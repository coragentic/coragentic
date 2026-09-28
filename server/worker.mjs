import { randomUUID } from 'node:crypto';

const DEFAULT_LEASE_MS = 30_000;
const DEFAULT_MAX_ATTEMPTS = 3;

const timestamp = () => new Date().toISOString();

function columnNames(db) {
  return new Set(db.prepare('PRAGMA table_info(jobs)').all().map((column) => column.name));
}

/** Add worker-owned state without changing the API's jobs lifecycle. */
export function migrateWorkerSchema(db) {
  const columns = columnNames(db);
  if (!columns.has('lease_owner')) db.exec('ALTER TABLE jobs ADD COLUMN lease_owner TEXT');
  if (!columns.has('lease_until')) db.exec('ALTER TABLE jobs ADD COLUMN lease_until INTEGER');
  if (!columns.has('attempts')) db.exec('ALTER TABLE jobs ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0');
  if (!columns.has('last_error')) db.exec('ALTER TABLE jobs ADD COLUMN last_error TEXT');
  db.exec('CREATE INDEX IF NOT EXISTS idx_jobs_worker_claim ON jobs(status, lease_until, attempts, created_at)');
}

function optionsFor(workerOrOptions, maybeOptions) {
  const options = typeof workerOrOptions === 'object' && workerOrOptions !== null
    ? workerOrOptions : { ...(maybeOptions || {}), workerId: workerOrOptions };
  return {
    workerId: options.workerId || randomUUID(),
    leaseMs: Math.max(1, Number(options.leaseMs ?? DEFAULT_LEASE_MS)),
    maxAttempts: Math.max(1, Number(options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS)),
    statuses: options.statuses || ['accepted'],
    now: Number(options.now ?? Date.now()),
  };
}

/** Claim exactly one eligible job under SQLite's write lock. */
export function claimNextJob(db, workerOrOptions, maybeOptions) {
  const options = optionsFor(workerOrOptions, maybeOptions);
  migrateWorkerSchema(db);
  const placeholders = options.statuses.map(() => '?').join(', ');
  if (!placeholders) return null;
  db.exec('BEGIN IMMEDIATE');
  try {
    const row = db.prepare(`SELECT * FROM jobs
      WHERE status IN (${placeholders})
        AND attempts < ?
        AND (lease_until IS NULL OR lease_until <= ?)
      ORDER BY created_at, id LIMIT 1`).get(...options.statuses, options.maxAttempts, options.now);
    if (!row) { db.exec('COMMIT'); return null; }
    const leaseUntil = options.now + options.leaseMs;
    const changed = db.prepare(`UPDATE jobs SET lease_owner = ?, lease_until = ?,
      attempts = attempts + 1, last_error = NULL, updated_at = ?
      WHERE id = ? AND status IN (${placeholders}) AND attempts < ?
        AND (lease_until IS NULL OR lease_until <= ?)`).run(
      options.workerId, leaseUntil, timestamp(), row.id,
      ...options.statuses, options.maxAttempts, options.now,
    );
    if (changed.changes !== 1) { db.exec('COMMIT'); return null; }
    const claimed = db.prepare('SELECT * FROM jobs WHERE id = ?').get(row.id);
    db.exec('COMMIT');
    return claimed;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
    throw error;
  }
}

function leasePredicate(claimed) {
  return claimed.lease_owner != null
    ? 'lease_owner = ? AND lease_until = ?'
    : 'lease_owner IS NULL';
}

/** Compare-and-set a claimed job into its next lifecycle state. */
export function casTransition(db, claimed, nextStatus, { deliverable, error = null } = {}) {
  if (!claimed?.id) return false;
  const hasDeliverable = deliverable !== undefined;
  const values = [nextStatus, hasDeliverable ? JSON.stringify(deliverable) : claimed.deliverable_json, error, timestamp(), claimed.id, claimed.status];
  const predicate = leasePredicate(claimed);
  if (claimed.lease_owner != null) values.push(claimed.lease_owner, claimed.lease_until);
  const result = db.prepare(`UPDATE jobs SET status = ?, deliverable_json = ?, last_error = ?,
    lease_owner = NULL, lease_until = NULL, updated_at = ?
    WHERE id = ? AND status = ? AND ${predicate}`).run(...values);
  return result.changes === 1;
}

export const transitionJob = casTransition;

function recordFailure(db, claimed, message, maxAttempts) {
  if (!claimed?.id) return false;
  const nextStatus = claimed.attempts >= maxAttempts ? 'failed' : claimed.status;
  const predicate = leasePredicate(claimed);
  const values = [nextStatus, message, timestamp(), claimed.id, claimed.status];
  if (claimed.lease_owner != null) values.push(claimed.lease_owner, claimed.lease_until);
  const result = db.prepare(`UPDATE jobs SET status = ?, last_error = ?,
    lease_owner = NULL, lease_until = NULL, updated_at = ?
    WHERE id = ? AND status = ? AND ${predicate}`).run(...values);
  return result.changes === 1;
}

/** Claim, execute, and CAS-submit one job; failures are bounded by maxAttempts. */
export async function processJob(db, executor, workerOrOptions, maybeOptions) {
  const options = optionsFor(workerOrOptions, maybeOptions);
  const claimed = claimNextJob(db, options);
  if (!claimed) return { outcome: 'idle', job: null };
  try {
    const deliverable = await executor(claimed);
    if (!casTransition(db, claimed, 'submitted', { deliverable })) {
      return { outcome: 'lost', job: claimed };
    }
    return { outcome: 'submitted', job: claimed };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const recorded = recordFailure(db, claimed, message, options.maxAttempts);
    return { outcome: recorded && claimed.attempts >= options.maxAttempts ? 'failed' : 'retry', job: claimed, error: message };
  }
}
