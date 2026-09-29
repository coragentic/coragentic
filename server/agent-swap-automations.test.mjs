import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from './db.mjs';
import { migrateSwarmSchema } from './swarm.mjs';
import { migrateAutomationSchema } from './agent-automations.mjs';
import { parseSwapCommand, executeDueSwapAutomations, migrateSwapSchema } from './agent-swap-automations.mjs';

const owner = '0x4444444444444444444444444444444444444444';

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'swap-auto-'));
  const db = openDatabase(join(dir, 'db.sqlite'));
  migrateSwarmSchema(db);
  migrateAutomationSchema(db);
  migrateSwapSchema(db);
  const stamp = new Date().toISOString();
  db.prepare('INSERT INTO agents (id, owner_wallet, name, description, services_json, capabilities_json, supported_trust_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run('agent_s', owner, 'S', 'd', '[]', '[]', '[]', stamp, stamp);
  db.prepare('INSERT INTO agent_wallets (agent_id, owner_wallet, address, encrypted_private_key, policy_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run('agent_s', owner, '0x5555555555555555555555555555555555555555', 'v1.x.y.z', '{"spendEnabled":true,"dailyLimitUsd":5,"allowedSkills":["web3"],"requireOwnerApproval":false}', stamp, stamp);
  return { dir, db };
}

test('parseSwapCommand understands a natural swap command', () => {
  const parsed2 = parseSwapCommand('swap eth to usdg 0.01 every day', { agentId: 'agent_s' });
  assert.ok(parsed2);
  assert.equal(parsed2.tokenOutSymbol.toLowerCase(), 'usdg');
  assert.equal(parsed2.amountEth, '0.01');
  assert.equal(parsed2.schedule.intervalMinutes, 1440);
  assert.equal(parsed2.recurring, true);
  const parsed3 = parseSwapCommand('swap 0.05 eth to usdg daily', { agentId: 'agent_s' });
  assert.ok(parsed3);
  assert.equal(parsed3.amountEth, '0.05');
  assert.equal(parseSwapCommand('what is the weather'), null);
});

test('executeDueSwapAutomations marks no-gas as failed honestly, never fakes success', async () => {
  const { dir, db } = setup();
  try {
    const { createAutomation } = await import('./agent-automations.mjs');
    const { USDG } = await import('./rh-swap.mjs');
    const automation = createAutomation(db, { agentId: 'agent_s', ownerWallet: owner, task: `swap eth to usdg 0.01 daily`, schedule: { kind: 'interval', intervalMinutes: 1440 } });
    // Force due immediately
    db.prepare('UPDATE agent_automations SET next_run_at = ? WHERE id = ?').run(new Date(Date.now() - 1000).toISOString(), automation.id);
    // The custody wallet address has no funded key we can control here and no
    // ETH balance; execution must record an honest failure, not a fake pass.
    const results = await executeDueSwapAutomations(db, { rpcUrl: 'http://127.0.0.1:1', now: new Date() });
    const row = db.prepare('SELECT last_result_json FROM agent_automations WHERE id = ?').get(automation.id);
    const last = JSON.parse(row.last_result_json);
    assert.equal(last.ok, false);
    assert.ok(last.summary.length > 0);
    assert.equal(results.length, 1);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});
