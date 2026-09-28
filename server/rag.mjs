import { randomUUID } from 'node:crypto';

// Local-first retrieval uses SQLite FTS5 keyword search. Semantic embeddings are
// optional and not yet present; callers can add them without changing this API.

const asTags = (value) => {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (typeof value === 'string') {
    try { return asTags(JSON.parse(value)); } catch { return value.split(',').map((tag) => tag.trim()).filter(Boolean); }
  }
  return [];
};
const tokens = (query) => [...new Set(String(query ?? '').toLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? [])];
const ftsQuery = (query) => tokens(query).map((token) => `"${token.replaceAll('"', '""')}"`).join(' OR ');
const rowResult = (row) => ({
  id: row.id,
  agentId: row.agent_id,
  ownerWallet: row.owner_wallet,
  key: row.memory_key,
  content: row.content,
  tags: asTags(row.tags_json),
  timestamp: row.updated_at,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  score: row.score == null ? null : Number(row.score),
});

export function migrateRagSchema(db) {
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS agent_memory_fts USING fts5(
      memory_id UNINDEXED, memory_key, content, tags
    );
    CREATE TABLE IF NOT EXISTS memory_provenance (
      memory_id TEXT PRIMARY KEY,
      source_type TEXT,
      source_id TEXT,
      source_uri TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_memory_provenance_source ON memory_provenance(source_type, source_id);
  `);
  // ponytail: rebuild is simple and deterministic; optimize to incremental triggers only if scale requires it.
  db.exec('DELETE FROM agent_memory_fts');
  db.exec(`INSERT INTO agent_memory_fts (memory_id, memory_key, content, tags)
    SELECT id, memory_key, content, tags_json FROM agent_memory`);
  return db;
}

export function indexMemory(db, memory) {
  migrateRagSchema(db);
  db.prepare('DELETE FROM agent_memory_fts WHERE memory_id = ?').run(memory.id);
  db.prepare('INSERT INTO agent_memory_fts (memory_id, memory_key, content, tags) VALUES (?, ?, ?, ?)')
    .run(memory.id, memory.memoryKey ?? memory.key ?? '', memory.content ?? '', asTags(memory.tags ?? memory.tagsJson).join(' '));
  return memory.id;
}

export function recall(db, query, options = {}) {
  migrateRagSchema(db);
  const match = ftsQuery(query);
  const where = options.agentId && options.ownerWallet
    ? 'WHERE m.agent_id = ? AND m.owner_wallet = ?'
    : options.agentId
      ? 'WHERE m.agent_id = ?'
      : options.ownerWallet
        ? 'WHERE m.owner_wallet = ?'
        : '';
  const args = [options.agentId, options.ownerWallet].filter(Boolean);
  const limit = Math.max(1, Math.min(100, Number(options.limit ?? 20)));
  if (!match) {
    return db.prepare(`SELECT m.*, NULL AS score FROM agent_memory m ${where} ORDER BY m.updated_at DESC, m.id ASC LIMIT ?`).all(...args, limit).map(rowResult);
  }
  // FTS query needs its own WHERE-within-MATCH structure; build separately to avoid arg mismatch
  const ftsOwnerFilter = options.ownerWallet ? 'AND m.owner_wallet = ?' : '';
  const ftsAgentFilter = options.agentId ? 'AND m.agent_id = ?' : '';
  const ftsArgs = [options.agentId, options.ownerWallet].filter(Boolean);
  const rows = db.prepare(`SELECT m.*, bm25(agent_memory_fts) AS score
    FROM agent_memory_fts JOIN agent_memory m ON m.id = agent_memory_fts.memory_id
    WHERE agent_memory_fts MATCH ? ${ftsAgentFilter} ${ftsOwnerFilter}
    ORDER BY score ASC, m.updated_at DESC, m.id ASC LIMIT ?`).all(match, ...ftsArgs, limit);
  // FTS supplies the candidate set; this explicit field weighting keeps ranking
  // deterministic across SQLite builds and makes key/tag matches intentional.
  return rows.map((row) => {
    const haystack = (value) => String(value ?? '').toLowerCase();
    const tagText = asTags(row.tags_json).join(' ');
    const score = tokens(query).reduce((total, token) => total
      + (haystack(row.memory_key).includes(token) ? 5 : 0)
      + (haystack(tagText).includes(token) ? 3 : 0)
      + (haystack(row.content).includes(token) ? 1 : 0), 0);
    return { ...row, score };
  }).sort((a, b) => b.score - a.score || b.updated_at.localeCompare(a.updated_at) || a.id.localeCompare(b.id)).map(rowResult);
}

export function contextPack(db, query, budget = 4000, options = {}) {
  const max = Math.max(0, Number(budget) || 0);
  const candidates = recall(db, query, options);
  const evidence = [];
  let text = '';
  for (const item of candidates) {
    const line = `[${item.id}] ${item.timestamp} tags=${item.tags.join(',') || '-'} key=${item.key}: ${item.content}`;
    if (line.length > max - text.length) {
      if (!evidence.length && max > 0) {
        evidence.push(item);
        text = line.slice(0, max);
      }
      break;
    }
    evidence.push(item);
    text += `${text ? '\n' : ''}${line}`;
  }
  return { query: String(query ?? ''), budget: max, text, evidence, semanticEmbeddings: 'optional-not-present' };
}

export function retainMemory(db, input, defaults = {}) {
  migrateRagSchema(db);
  const agentId = input.agentId ?? defaults.agentId;
  const ownerWallet = input.ownerWallet ?? defaults.ownerWallet;
  const key = input.key ?? input.memoryKey;
  if (!agentId || !ownerWallet || !key || typeof input.content !== 'string') throw new TypeError('agentId, ownerWallet, key, and content are required');
  const now = (defaults.now ?? (() => new Date().toISOString()))();
  const existing = db.prepare('SELECT id, created_at FROM agent_memory WHERE agent_id = ? AND memory_key = ?').get(agentId, key);
  const id = existing?.id ?? input.id ?? randomUUID();
  db.prepare(`INSERT INTO agent_memory (id, agent_id, owner_wallet, memory_key, content, tags_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(agent_id, memory_key) DO UPDATE SET owner_wallet=excluded.owner_wallet,
      content=excluded.content, tags_json=excluded.tags_json, updated_at=excluded.updated_at`)
    .run(id, agentId, ownerWallet, key, input.content, JSON.stringify(asTags(input.tags)), existing?.created_at ?? now, now);
  indexMemory(db, { id, memoryKey: key, content: input.content, tags: input.tags });
  if (input.provenance) {
    const p = input.provenance;
    db.prepare(`INSERT INTO memory_provenance (memory_id, source_type, source_id, source_uri, metadata_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(memory_id) DO UPDATE SET source_type=excluded.source_type,
      source_id=excluded.source_id, source_uri=excluded.source_uri, metadata_json=excluded.metadata_json`)
      .run(id, p.sourceType ?? null, p.sourceId ?? null, p.sourceUri ?? null, JSON.stringify(p.metadata ?? {}), now);
  }
  return id;
}

export function forgetMemory(db, id, options = {}) {
  const result = db.prepare(options.agentId ? 'DELETE FROM agent_memory WHERE id = ? AND agent_id = ?' : 'DELETE FROM agent_memory WHERE id = ?')
    .run(...(options.agentId ? [id, options.agentId] : [id]));
  if (!result.changes) return false;
  db.prepare('DELETE FROM agent_memory_fts WHERE memory_id = ?').run(id);
  db.prepare('DELETE FROM memory_provenance WHERE memory_id = ?').run(id);
  return true;
}

export function createMemoryAdapter(db, defaults = {}) {
  migrateRagSchema(db);
  return Object.freeze({
    retain: (input) => retainMemory(db, input, defaults),
    recall: (query, options = {}) => recall(db, query, { ...options, agentId: options.agentId ?? defaults.agentId }),
    contextPack: (query, budget, options = {}) => contextPack(db, query, budget, { ...options, agentId: options.agentId ?? defaults.agentId }),
    forget: (id) => forgetMemory(db, id, { agentId: defaults.agentId }),
  });
}
