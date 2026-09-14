import type Database from 'better-sqlite3';

export const version = 6;
export const name = 'adding api keys and rate limiting tables';

export const up = (db: Database): void => {
  db.exec(`
      CREATE TABLE IF NOT EXISTS api_keys (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        key_hash TEXT UNIQUE NOT NULL,
        permissions TEXT NOT NULL DEFAULT '["read","write"]',
        created_at INTEGER NOT NULL,
        last_used_at INTEGER,
        enabled INTEGER DEFAULT 1
      );

      CREATE TABLE IF NOT EXISTS rate_limit_log (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        trace_id TEXT NOT NULL,
        dropped_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_api_keys_key_hash ON api_keys(key_hash);
      CREATE INDEX IF NOT EXISTS idx_api_keys_enabled ON api_keys(enabled);
      CREATE INDEX IF NOT EXISTS idx_rate_limit_log_tenant ON rate_limit_log(tenant_id, dropped_at);
  `);
};
