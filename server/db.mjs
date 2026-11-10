import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { appRoot } from './config.mjs';

const dataDir = path.join(appRoot, 'data');
fs.mkdirSync(dataDir, { recursive: true });
const db = new DatabaseSync(path.join(dataDir, 'agent-relay.db'));

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sticky_agents (
    key TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    system_prompt TEXT NOT NULL,
    model TEXT NOT NULL,
    tool_policy TEXT NOT NULL,
    budget_cents INTEGER NOT NULL,
    remote_agent_id TEXT NOT NULL,
    environment_id TEXT NOT NULL,
    memory_store_id TEXT NOT NULL,
    session_id TEXT,
    status TEXT NOT NULL DEFAULT 'idle',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_used_at TEXT
  );
  CREATE TABLE IF NOT EXISTS session_history (
    agent_key TEXT NOT NULL,
    session_id TEXT NOT NULL,
    archived_at TEXT NOT NULL,
    PRIMARY KEY (agent_key, session_id),
    FOREIGN KEY (agent_key) REFERENCES sticky_agents(key) ON DELETE CASCADE
  );
`);

const now = () => new Date().toISOString();
const mapAgent = (row) => row ? ({
  key: row.key,
  name: row.name,
  system: row.system_prompt,
  model: row.model,
  toolPolicy: row.tool_policy,
  budgetCents: row.budget_cents,
  remoteAgentId: row.remote_agent_id,
  environmentId: row.environment_id,
  memoryStoreId: row.memory_store_id,
  sessionId: row.session_id,
  status: row.status,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  lastUsedAt: row.last_used_at,
}) : null;

export const store = {
  getSetting(key) {
    return db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value || null;
  },
  setSetting(key, value) {
    db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, value);
  },
  listAgents() {
    return db.prepare('SELECT * FROM sticky_agents ORDER BY created_at ASC').all().map(mapAgent);
  },
  getAgent(key) {
    return mapAgent(db.prepare('SELECT * FROM sticky_agents WHERE key = ?').get(key));
  },
  createAgent(agent) {
    const timestamp = now();
    db.prepare(`INSERT INTO sticky_agents (
      key, name, system_prompt, model, tool_policy, budget_cents, remote_agent_id,
      environment_id, memory_store_id, session_id, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'idle', ?, ?)`).run(
      agent.key, agent.name, agent.system, agent.model, agent.toolPolicy,
      agent.budgetCents, agent.remoteAgentId, agent.environmentId,
      agent.memoryStoreId, agent.sessionId || null, timestamp, timestamp,
    );
    return this.getAgent(agent.key);
  },
  updateAgent(key, patch) {
    const current = this.getAgent(key);
    if (!current) return null;
    const next = { ...current, ...patch, updatedAt: now() };
    db.prepare(`UPDATE sticky_agents SET name = ?, system_prompt = ?, model = ?,
      tool_policy = ?, budget_cents = ?, session_id = ?, status = ?,
      updated_at = ?, last_used_at = ? WHERE key = ?`).run(
      next.name, next.system, next.model, next.toolPolicy, next.budgetCents,
      next.sessionId || null, next.status, next.updatedAt, next.lastUsedAt || null, key,
    );
    return this.getAgent(key);
  },
  recordSessionHistory(key, sessionId) {
    db.prepare('INSERT OR IGNORE INTO session_history (agent_key, session_id, archived_at) VALUES (?, ?, ?)')
      .run(key, sessionId, now());
  },
  close() {
    db.close();
  },
};
