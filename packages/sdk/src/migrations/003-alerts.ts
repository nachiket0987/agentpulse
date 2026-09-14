import type Database from 'better-sqlite3';

export const version = 3;
export const name = 'adding alerts tables';

export const up = (db: Database): void => {
  db.exec(`
      CREATE TABLE IF NOT EXISTS alerts (
        id TEXT PRIMARY KEY,
        name TEXT UNIQUE NOT NULL,
        config TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS alert_history (
        id TEXT PRIMARY KEY,
        alert_name TEXT NOT NULL,
        triggered_at INTEGER NOT NULL,
        stats TEXT NOT NULL,
        delivered INTEGER DEFAULT 0,
        error TEXT,
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_alerts_name ON alerts(name);
      CREATE INDEX IF NOT EXISTS idx_alert_history_alert_name ON alert_history(alert_name);
      CREATE INDEX IF NOT EXISTS idx_alert_history_triggered_at ON alert_history(triggered_at);
  `);
};
