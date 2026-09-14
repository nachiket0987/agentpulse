import type Database from 'better-sqlite3';

export const version = 2;
export const name = 'adding scores table';

export const up = (db: Database): void => {
  db.exec(`
      CREATE TABLE IF NOT EXISTS scores (
        id TEXT PRIMARY KEY,
        trace_id TEXT NOT NULL REFERENCES traces(id),
        name TEXT NOT NULL,
        value REAL NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_scores_trace_id ON scores(trace_id);
      CREATE INDEX IF NOT EXISTS idx_scores_name ON scores(name);
  `);
};
