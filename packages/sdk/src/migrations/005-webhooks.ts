import type Database from 'better-sqlite3';

export const version = 5;
export const name = 'adding webhooks table';

export const up = (db: Database): void => {
  db.exec(`
      CREATE TABLE IF NOT EXISTS webhooks (
        id TEXT PRIMARY KEY,
        url TEXT NOT NULL,
        secret TEXT,
        events TEXT NOT NULL DEFAULT '[]',
        enabled INTEGER DEFAULT 1,
        created_at INTEGER NOT NULL,
        last_triggered_at INTEGER,
        failure_count INTEGER DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS webhook_deliveries (
        id TEXT PRIMARY KEY,
        webhook_id TEXT NOT NULL,
        event TEXT NOT NULL,
        payload TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'success',
        http_status INTEGER,
        error TEXT,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (webhook_id) REFERENCES webhooks(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_webhooks_enabled ON webhooks(enabled);
      CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_webhook_id ON webhook_deliveries(webhook_id);
      CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_created_at ON webhook_deliveries(created_at);
  `);
};
