import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export function openDatabase(path = process.env.CORAGENTIC_DB || 'data/coragentic.sqlite') {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS auth_challenges (
      nonce TEXT PRIMARY KEY,
      wallet TEXT NOT NULL,
      message TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      used_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      wallet TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      owner_wallet TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      image TEXT,
      services_json TEXT NOT NULL,
      capabilities_json TEXT NOT NULL,
      supported_trust_json TEXT NOT NULL,
      x402_support INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'draft',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_agents_status ON agents(status);
    CREATE INDEX IF NOT EXISTS idx_agents_owner ON agents(owner_wallet);
    CREATE TABLE IF NOT EXISTS offerings (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL REFERENCES agents(id),
      owner_wallet TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      price_atomic TEXT NOT NULL,
      asset TEXT NOT NULL,
      network TEXT NOT NULL,
      requirements_json TEXT NOT NULL,
      deliverables_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_offerings_agent_status ON offerings(agent_id, status);
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      offering_id TEXT NOT NULL REFERENCES offerings(id),
      buyer_wallet TEXT NOT NULL,
      seller_wallet TEXT NOT NULL,
      requirements_json TEXT NOT NULL,
      status TEXT NOT NULL,
      payment_json TEXT NOT NULL,
      deliverable_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_jobs_buyer ON jobs(buyer_wallet);
    CREATE INDEX IF NOT EXISTS idx_jobs_seller ON jobs(seller_wallet);
    CREATE TABLE IF NOT EXISTS audit_events (
      id TEXT PRIMARY KEY,
      actor_wallet TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_events(entity_type, entity_id, created_at);
    CREATE TABLE IF NOT EXISTS agent_memory (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL REFERENCES agents(id),
      owner_wallet TEXT NOT NULL,
      memory_key TEXT NOT NULL,
      content TEXT NOT NULL,
      tags_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(agent_id, memory_key)
    );
    CREATE INDEX IF NOT EXISTS idx_agent_memory_agent ON agent_memory(agent_id, updated_at);
    CREATE TABLE IF NOT EXISTS agent_runs (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL REFERENCES agents(id),
      owner_wallet TEXT NOT NULL,
      kind TEXT NOT NULL,
      request TEXT NOT NULL,
      result_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_agent_runs_agent ON agent_runs(agent_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS agent_wallets (
      agent_id TEXT PRIMARY KEY REFERENCES agents(id),
      owner_wallet TEXT NOT NULL,
      address TEXT NOT NULL UNIQUE,
      encrypted_private_key TEXT NOT NULL,
      policy_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS agent_skills (
      agent_id TEXT NOT NULL REFERENCES agents(id),
      owner_wallet TEXT NOT NULL,
      skill_id TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      config_json TEXT NOT NULL DEFAULT '{}',
      installed_at TEXT NOT NULL,
      PRIMARY KEY(agent_id, skill_id)
    );
    CREATE TABLE IF NOT EXISTS x402_settlements (
      tx_hash TEXT PRIMARY KEY,
      offering_id TEXT NOT NULL REFERENCES offerings(id),
      payer_wallet TEXT NOT NULL,
      amount_atomic TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_x402_settlements_offering ON x402_settlements(offering_id);
  `);
  // Legacy agents created before templates had an empty capability array,
  // which made a real working agent read as "No capabilities declared" even
  // though its native Brain and context workflow are available. Upgrade the
  // baseline honestly to the two capabilities every existing agent can use;
  // template-specific capabilities remain opt-in at creation time.
  db.prepare("UPDATE agents SET capabilities_json = ? WHERE capabilities_json = '[]'").run(JSON.stringify(['context', 'analysis']));
  // observed transfer cannot be claimed as payment for any other same-price
  // offering; added via ALTER for compatibility with existing databases.
  const settlementColumns = new Set(db.prepare('PRAGMA table_info(x402_settlements)').all().map((row) => row.name));
  if (!settlementColumns.has('job_id')) db.exec('ALTER TABLE x402_settlements ADD COLUMN job_id TEXT REFERENCES jobs(id)');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_x402_settlements_job ON x402_settlements(job_id) WHERE job_id IS NOT NULL');
  return db;
}

export function cleanupExpired(db, now = Date.now()) {
  const challenges = db.prepare('DELETE FROM auth_challenges WHERE expires_at < ? OR used_at IS NOT NULL').run(now);
  const sessions = db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now);
  return { challenges: challenges.changes, sessions: sessions.changes };
}