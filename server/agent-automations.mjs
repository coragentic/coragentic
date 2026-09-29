import { randomUUID } from 'node:crypto';

// Owner-scoped scheduled agent tasks. An automation is durable state: it
// survives restarts, is claimed like other durable work, and records its
// latest execution result next to its schedule. Nothing here executes on
// chain or spends funds -- an automation run enqueues a brain/swarm task
// exactly like an owner pressing the button.
const timestamp = () => new Date().toISOString();

export function migrateAutomationSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_automations (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL REFERENCES agents(id),
      owner_wallet TEXT NOT NULL,
      task TEXT NOT NULL,
      schedule_json TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      next_run_at TEXT NOT NULL,
      last_run_at TEXT,
      last_result_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_agent_automations_due ON agent_automations(enabled, next_run_at);
  `);
}

export function computeNextRunAt(schedule, from = new Date()) {
  if (schedule?.kind === 'interval' && Number.isFinite(schedule.intervalMinutes) && schedule.intervalMinutes > 0) {
    return new Date(from.getTime() + schedule.intervalMinutes * 60_000).toISOString();
  }
  if (schedule?.kind === 'daily' && typeof schedule.timeUtc === 'string' && /^\d{2}:\d{2}$/.test(schedule.timeUtc)) {
    const [hours, minutes] = schedule.timeUtc.split(':').map(Number);
    const next = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate(), hours, minutes));
    if (next <= from) next.setUTCDate(next.getUTCDate() + 1);
    return next.toISOString();
  }
  throw new Error('invalid_automation_schedule');
}

export function createAutomation(db, { agentId, ownerWallet, task, schedule }) {
  const now = timestamp();
  const row = {
    id: randomUUID(),
    agent_id: agentId,
    owner_wallet: ownerWallet,
    task: String(task),
    schedule_json: JSON.stringify(schedule),
    enabled: 1,
    next_run_at: computeNextRunAt(schedule, new Date()),
    created_at: now,
    updated_at: now,
  };
  db.prepare('INSERT INTO agent_automations (id, agent_id, owner_wallet, task, schedule_json, enabled, next_run_at, created_at, updated_at) VALUES (@id, @agent_id, @owner_wallet, @task, @schedule_json, @enabled, @next_run_at, @created_at, @updated_at)').run(row);
  return automationResponse(row);
}

function automationResponse(row) {
  return {
    id: row.id,
    agentId: row.agent_id,
    task: row.task,
    schedule: JSON.parse(row.schedule_json),
    enabled: Boolean(row.enabled),
    nextRunAt: row.next_run_at,
    lastRunAt: row.last_run_at ?? null,
    lastResult: row.last_result_json ? JSON.parse(row.last_result_json) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function dueAutomations(db, now = new Date()) {
  return db.prepare('SELECT * FROM agent_automations WHERE enabled = 1 AND next_run_at <= ? ORDER BY next_run_at ASC').all(now.toISOString()).map(automationResponse);
}

/** Claim-by-update so two workers cannot double-run the same due automation. */
export function claimDueAutomation(db, automationId, now = new Date()) {
  const claimed = db.prepare(`UPDATE agent_automations SET next_run_at = ?, updated_at = ?
    WHERE id = ? AND enabled = 1 AND next_run_at <= ?`).run(
    computeNextRunAt({ kind: 'interval', intervalMinutes: 5 }, now), timestamp(), automationId, now.toISOString(),
  );
  return claimed.changes === 1;
}

export function markAutomationRun(db, automationId, { ok, runId = null, summary = '', nextRunAt = null }) {
  const row = db.prepare('SELECT schedule_json FROM agent_automations WHERE id = ?').get(automationId);
  if (!row) return;
  const next = nextRunAt ?? computeNextRunAt(JSON.parse(row.schedule_json), new Date());
  db.prepare('UPDATE agent_automations SET next_run_at = ?, last_run_at = ?, last_result_json = ?, updated_at = ? WHERE id = ?')
    .run(next, timestamp(), JSON.stringify({ ok, runId, summary, at: timestamp() }), timestamp(), automationId);
}
