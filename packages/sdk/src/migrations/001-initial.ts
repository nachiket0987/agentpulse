import type Database from 'better-sqlite3';

export const version = 1;
export const name = 'initial schema';

export const up = (db: Database): void => {
  db.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'running',
        trace_count INTEGER DEFAULT 0,
        total_prompt_tokens INTEGER DEFAULT 0,
        total_completion_tokens INTEGER DEFAULT 0,
        total_tokens INTEGER DEFAULT 0,
        total_tool_calls INTEGER DEFAULT 0,
        total_latency_ms INTEGER DEFAULT 0,
        total_cost_usd REAL DEFAULT 0,
        error_count INTEGER DEFAULT 0,
        started_at INTEGER NOT NULL,
        completed_at INTEGER,
        metadata TEXT DEFAULT '{}',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS traces (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        name TEXT NOT NULL,
        status TEXT NOT NULL,
        input TEXT,
        output TEXT,
        prompt_tokens INTEGER DEFAULT 0,
        completion_tokens INTEGER DEFAULT 0,
        total_tokens INTEGER DEFAULT 0,
        model TEXT,
        provider TEXT,
        latency_ms INTEGER DEFAULT 0,
        cost_usd REAL DEFAULT 0,
        error TEXT,
        metadata TEXT DEFAULT '{}',
        parent_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS tool_calls (
        id TEXT PRIMARY KEY,
        trace_id TEXT NOT NULL,
        name TEXT NOT NULL,
        input TEXT,
        output TEXT,
        latency_ms INTEGER DEFAULT 0,
        success INTEGER DEFAULT 1,
        error TEXT,
        timestamp INTEGER NOT NULL,
        FOREIGN KEY (trace_id) REFERENCES traces(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_traces_run_id ON traces(run_id);
      CREATE INDEX IF NOT EXISTS idx_traces_status ON traces(status);
      CREATE INDEX IF NOT EXISTS idx_traces_created_at ON traces(created_at);
      CREATE INDEX IF NOT EXISTS idx_traces_cost ON traces(cost_usd);
      CREATE INDEX IF NOT EXISTS idx_traces_parent_id ON traces(parent_id);
      CREATE INDEX IF NOT EXISTS idx_tool_calls_trace_id ON tool_calls(trace_id);
      CREATE INDEX IF NOT EXISTS idx_tool_calls_name ON tool_calls(name);

      CREATE TABLE IF NOT EXISTS version (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS trace_links (
        id TEXT PRIMARY KEY,
        source_trace_id TEXT NOT NULL,
        target_trace_id TEXT NOT NULL,
        relation TEXT NOT NULL DEFAULT 'related',
        created_at INTEGER NOT NULL,
        FOREIGN KEY (source_trace_id) REFERENCES traces(id) ON DELETE CASCADE,
        FOREIGN KEY (target_trace_id) REFERENCES traces(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_trace_links_source ON trace_links(source_trace_id);
      CREATE INDEX IF NOT EXISTS idx_trace_links_target ON trace_links(target_trace_id);
  `);
};
