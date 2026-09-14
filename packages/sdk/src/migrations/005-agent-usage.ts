import type Database from 'better-sqlite3';

export const version = 5;
export const name = 'adding agent_usage table';

export const up = (db: Database): void => {
  db.exec(`
      CREATE TABLE IF NOT EXISTS agent_usage (
        id TEXT PRIMARY KEY,
        agent_name TEXT NOT NULL,
        agent_type TEXT,
        session_id TEXT,
        action TEXT NOT NULL,
        target TEXT,
        tokens_used INTEGER DEFAULT 0,
        cost_usd REAL DEFAULT 0,
        duration_ms INTEGER DEFAULT 0,
        status TEXT DEFAULT 'success',
        metadata TEXT DEFAULT '{}',
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_agent_usage_agent_name ON agent_usage(agent_name);
      CREATE INDEX IF NOT EXISTS idx_agent_usage_session_id ON agent_usage(session_id);
      CREATE INDEX IF NOT EXISTS idx_agent_usage_action ON agent_usage(action);
      CREATE INDEX IF NOT EXISTS idx_agent_usage_status ON agent_usage(status);
      CREATE INDEX IF NOT EXISTS idx_agent_usage_created_at ON agent_usage(created_at);
  `);
};
