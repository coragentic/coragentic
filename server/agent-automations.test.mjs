import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from './db.mjs';
import { migrateSwarmSchema } from './swarm.mjs';
import { createAutomation, dueAutomations, markAutomationRun, migrateAutomationSchema } from './agent-automations.mjs';

const owner = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const owner2 = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'coragentic-automations-'));
  const db = openDatabase(join(dir, 'db.sqlite'));
  migrateSwarmSchema(db);
  migrateAutomationSchema(db);
  db.prepare('INSERT INTO agents (id, owner_wallet, name, description, services_json, capabilities_json, supported_trust_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run('agent_a', owner, 'A', 'd', '[]', '[]', '[]', new Date().toISOString(), new Date().toISOString());
  db.prepare('INSERT INTO agents (id, owner_wallet, name, description, services_json, capabilities_json, supported_trust_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run('agent_b', owner2, 'B', 'd', '[]', '[]', '[]', new Date().toISOString(), new Date().toISOString());
  return { dir, db };
}

test('createAutomation persists a due automation scoped to its agent owner', () => {
  const { dir, db } = setup();
  try {
    const automation = createAutomation(db, { agentId: 'agent_a', ownerWallet: owner, schedule: { kind: 'interval', intervalMinutes: 15 }, task: 'Summarize new retained context' });
    assert.equal(automation.agentId, 'agent_a');
    assert.equal(automation.enabled, true);
    assert.deepEqual(automation.schedule, { kind: 'interval', intervalMinutes: 15 });
    assert.ok(automation.nextRunAt <= new Date(Date.now() + 15 * 60_000 + 5_000).toISOString());
    assert.ok(automation.nextRunAt >= new Date(Date.now() + 14 * 60_000).toISOString());
    const due = dueAutomations(db, new Date(Date.now() + 16 * 60_000));
    assert.equal(due.length, 1);
    assert.equal(due[0].id, automation.id);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('dueAutomations only returns run-due, enabled automations and never crosses owners', () => {
  const { dir, db } = setup();
  try {
    createAutomation(db, { agentId: 'agent_a', ownerWallet: owner, schedule: { kind: 'interval', intervalMinutes: 15 }, task: 'a' });
    createAutomation(db, { agentId: 'agent_b', ownerWallet: owner2, schedule: { kind: 'interval', intervalMinutes: 15 }, task: 'b' });
    const future = new Date(Date.now() + 20 * 60_000).toISOString();
    db.prepare('UPDATE agent_automations SET next_run_at = ? WHERE agent_id = ?').run(future, 'agent_b');
    const due = dueAutomations(db, new Date(Date.now() + 16 * 60_000));
    assert.deepEqual(due.map((row) => row.agentId), ['agent_a']);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('markAutomationRun advances next_run_at and records execution state', () => {
  const { dir, db } = setup();
  try {
    const automation = createAutomation(db, { agentId: 'agent_a', ownerWallet: owner, schedule: { kind: 'interval', intervalMinutes: 15 }, task: 'a' });
    const before = Date.now();
    markAutomationRun(db, automation.id, { ok: true, runId: 'run_1', summary: 'did the thing' });
    const row = db.prepare('SELECT * FROM agent_automations WHERE id = ?').get(automation.id);
    assert.ok(new Date(row.next_run_at).getTime() >= before + 14 * 60_000);
    const history = JSON.parse(row.last_result_json);
    assert.equal(history.ok, true);
    assert.equal(history.runId, 'run_1');
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('disabled automations never become due', () => {
  const { dir, db } = setup();
  try {
    const automation = createAutomation(db, { agentId: 'agent_a', ownerWallet: owner, schedule: { kind: 'interval', intervalMinutes: 15 }, task: 'a' });
    db.prepare('UPDATE agent_automations SET enabled = 0 WHERE id = ?').run(automation.id);
    assert.equal(dueAutomations(db, new Date()).length, 0);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});
