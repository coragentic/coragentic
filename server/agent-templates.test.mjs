import test from 'node:test';
import assert from 'node:assert/strict';
import { starterVaultForTemplate } from './agent-templates.mjs';

test('research template creates a complete starter vault with an executable first task', () => {
  const entries = starterVaultForTemplate('research', { name: 'Atlas', description: 'Research payment systems' });
  assert.deepEqual(entries.map((entry) => entry.key), ['mission', 'operating-context', 'first-task']);
  assert.match(entries[0].content, /Research payment systems/);
  assert.match(entries[2].content, /first research brief/i);
});

test('blank template still creates an editable operating baseline, never an empty workspace', () => {
  const entries = starterVaultForTemplate('blank', { name: 'Atlas', description: 'A new agent' });
  assert.equal(entries.length, 3);
  assert.ok(entries.every((entry) => entry.content.trim().length > 0));
});

test('unknown template fails closed instead of inventing a starter vault', () => {
  assert.throws(() => starterVaultForTemplate('made-up', { name: 'Atlas', description: 'A new agent' }), /invalid_agent_template/);
});
