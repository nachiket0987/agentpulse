import type Database from 'better-sqlite3';

export const version = 4;
export const name = 'adding trace_context table';

export const up = (db: Database): void => {
  db.exec(`
      CREATE TABLE IF NOT EXISTS trace_context (
        id TEXT PRIMARY KEY,
        trace_id TEXT NOT NULL,
        parent_span_id TEXT,
        metadata TEXT DEFAULT '{}',
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_trace_context_trace_id ON trace_context(trace_id);
  `);
};
