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
    CREATE TABLE IF NOT EXISTS x402_settlements (
      tx_hash TEXT PRIMARY KEY,
      offering_id TEXT NOT NULL REFERENCES offerings(id),
      payer_wallet TEXT NOT NULL,
      amount_atomic TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_x402_settlements_offering ON x402_settlements(offering_id);
  `);
  return db;
}

export function cleanupExpired(db, now = Date.now()) {
  const challenges = db.prepare('DELETE FROM auth_challenges WHERE expires_at < ? OR used_at IS NOT NULL').run(now);
  const sessions = db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now);
  return { challenges: challenges.changes, sessions: sessions.changes };
}