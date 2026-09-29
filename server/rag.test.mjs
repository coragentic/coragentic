import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import {
  migrateRagSchema,
  indexMemory,
  recall,
  contextPack,
  createMemoryAdapter,
  forgetMemory,
} from './rag.mjs';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'coragentic-rag-'));
  const db = new DatabaseSync(join(dir, 'rag.sqlite'));
  db.exec(`CREATE TABLE agent_memory (
    id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, owner_wallet TEXT NOT NULL,
    memory_key TEXT NOT NULL, content TEXT NOT NULL, tags_json TEXT NOT NULL,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    UNIQUE(agent_id, memory_key)
  )`);
  migrateRagSchema(db);
  return { db, dir };
}

function add(db, memory) {
  db.prepare(`INSERT INTO agent_memory
    (id, agent_id, owner_wallet, memory_key, content, tags_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(memory.id, memory.agentId, memory.ownerWallet, memory.key, memory.content,
      JSON.stringify(memory.tags), memory.createdAt, memory.updatedAt);
  indexMemory(db, { ...memory, memoryKey: memory.key });
}

function close(fixture) { fixture.db.close(); rmSync(fixture.dir, { recursive: true, force: true }); }

for (const pass of [1, 2]) test(`migration and indexing are idempotent (pass ${pass})`, () => {
  const f = fixture();
  try {
    add(f.db, { id: 'm1', agentId: 'a1', ownerWallet: 'w1', key: 'deployment', content: 'SQLite deployment notes', tags: ['ops'], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z' });
    migrateRagSchema(f.db);
    migrateRagSchema(f.db);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM agent_memory_fts').get().n, 1);
    assert.equal(recall(f.db, 'SQLite deployment', { agentId: 'a1' })[0].id, 'm1');
  } finally { close(f); }
});

test('keyword recall ranks key and tags alongside content and returns provenance', () => {
  const f = fixture();
  try {
    add(f.db, { id: 'content', agentId: 'a1', ownerWallet: 'w1', key: 'unrelated', content: 'deployment the service with care', tags: ['general'], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' });
    add(f.db, { id: 'tagged', agentId: 'a1', ownerWallet: 'w1', key: 'release', content: 'routine notes', tags: ['deployment'], createdAt: '2026-01-02T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z' });
    add(f.db, { id: 'keyed', agentId: 'a1', ownerWallet: 'w1', key: 'deployment', content: 'routine notes', tags: [], createdAt: '2026-01-03T00:00:00.000Z', updatedAt: '2026-01-03T00:00:00.000Z' });
    const rows = recall(f.db, 'deployment', { agentId: 'a1' });
    assert.deepEqual(rows.map((row) => row.id), ['keyed', 'tagged', 'content']);
    assert.equal(rows[0].timestamp, '2026-01-03T00:00:00.000Z');
    assert.deepEqual(rows[0].tags, []);
  } finally { close(f); }
});

test('contextPack is bounded and includes evidence metadata', () => {
  const f = fixture();
  try {
    add(f.db, { id: 'm1', agentId: 'a1', ownerWallet: 'w1', key: 'deploy', content: 'First deployment evidence.', tags: ['release'], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' });
    add(f.db, { id: 'm2', agentId: 'a1', ownerWallet: 'w1', key: 'deploy-two', content: 'Second deployment evidence.', tags: ['release'], createdAt: '2026-01-02T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z' });
    const pack = contextPack(f.db, 'deployment', 120, { agentId: 'a1', ownerWallet: 'w1' });
    assert.ok(pack.text.length <= 120);
    assert.equal(pack.semanticEmbeddings, 'optional-not-present');
    assert.ok(pack.evidence.every((item) => item.id && item.timestamp && Array.isArray(item.tags)));
    assert.match(pack.text, /m1|m2/);
  } finally { close(f); }
});

test('recall and context packs never cross an owner boundary for mixed-owner rows', () => {
  const f = fixture();
  try {
    add(f.db, { id: 'mine', agentId: 'shared-agent', ownerWallet: 'w1', key: 'mine-key', content: 'owner one private context', tags: ['mine-tag'], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' });
    add(f.db, { id: 'theirs', agentId: 'shared-agent', ownerWallet: 'w2', key: 'other-key', content: 'owner two private context', tags: ['other-tag'], createdAt: '2026-01-02T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z' });
    assert.deepEqual(recall(f.db, 'private context', { agentId: 'shared-agent', ownerWallet: 'w1' }).map((row) => row.id), ['mine']);
    const pack = contextPack(f.db, 'private context', 1000, { agentId: 'shared-agent', ownerWallet: 'w1' });
    assert.equal(JSON.stringify(pack).includes('owner two private context'), false);
    assert.equal(JSON.stringify(pack).includes('other-key'), false);
    assert.equal(JSON.stringify(pack).includes('other-tag'), false);
  } finally { close(f); }
});

test('adapter retain, recall, and forget update the index and provenance', () => {
  const f = fixture();
  try {
    const adapter = createMemoryAdapter(f.db, { agentId: 'a1', ownerWallet: 'w1', now: () => '2026-02-01T00:00:00.000Z' });
    const id = adapter.retain({ key: 'preferences', content: 'Use dark mode', tags: ['ui'], provenance: { sourceType: 'conversation', sourceId: 'thread-7' } });
    assert.equal(adapter.recall('dark mode')[0].id, id);
    const provenance = f.db.prepare('SELECT source_type, source_id FROM memory_provenance WHERE memory_id = ?').get(id);
    assert.equal(provenance.source_type, 'conversation');
    assert.equal(provenance.source_id, 'thread-7');
    assert.equal(adapter.forget(id), true);
    assert.deepEqual(adapter.recall('dark mode'), []);
    assert.equal(forgetMemory(f.db, id), false);
  } finally { close(f); }
});

test('adapter recall never leaks another owner\'s memory under a shared agentId', () => {
  const f = fixture();
  try {
    const adapterA = createMemoryAdapter(f.db, { agentId: 'shared-agent', ownerWallet: 'owner-a', now: () => '2026-02-01T00:00:00.000Z' });
    const adapterB = createMemoryAdapter(f.db, { agentId: 'shared-agent', ownerWallet: 'owner-b', now: () => '2026-02-01T00:00:00.000Z' });
    adapterA.retain({ key: 'mine', content: 'owner-a secret shared-topic' });
    adapterB.retain({ key: 'other', content: 'owner-b secret shared-topic' });
    const seenByA = adapterA.recall('shared-topic').map((row) => row.key);
    assert.deepEqual(seenByA, ['mine']);
    const seenByB = adapterB.recall('shared-topic').map((row) => row.key);
    assert.deepEqual(seenByB, ['other']);
  } finally { close(f); }
});
