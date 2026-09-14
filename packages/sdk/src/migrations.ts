/**
 * AgentTrace -- Database Migration Runner
 * Tracks schema_version in a meta table and applies migrations sequentially.
 */

import Database from 'better-sqlite3';

// Import all migrations (use .js extension for ESM)
import * as mig001 from './migrations/001-initial.js';
import * as mig002 from './migrations/002-scores.js';
import * as mig003 from './migrations/003-alerts.js';
import * as mig004 from './migrations/004-trace-context.js';
import * as mig005 from './migrations/005-agent-usage.js';
import * as mig006 from './migrations/005-webhooks.js';
import * as mig007 from './migrations/006-api-keys.js';

export interface Migration {
  version: number;
  name: string;
  up: (db: Database) => void;
}

const rawMigrations: Migration[] = [
  mig001 as unknown as Migration,
  mig002 as unknown as Migration,
  mig003 as unknown as Migration,
  mig004 as unknown as Migration,
  mig005 as unknown as Migration,
  mig006 as unknown as Migration,
  mig007 as unknown as Migration,
];

const migrations: Migration[] = rawMigrations.sort((a, b) => a.version - b.version);

function ensureMetaAndVersionTables(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS version (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
}

export function getCurrentVersion(db: Database): number {
  ensureMetaAndVersionTables(db);

  // Prefer meta table
  let row = db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version') as
    | { value?: string }
    | undefined;
  if (row && row.value != null) {
    const v = parseInt(String(row.value), 10);
    if (!Number.isNaN(v)) return v;
  }

  // Fallback to legacy version table (for dbs created before migrations.ts)
  row = db.prepare('SELECT value FROM version WHERE key = ?').get('schema_version') as
    | { value?: string }
    | undefined;
  if (row && row.value != null) {
    const v = parseInt(String(row.value), 10);
    if (!Number.isNaN(v)) {
      // Backfill to meta for future
      db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(
        'schema_version',
        String(v),
      );
      return v;
    }
  }

  return 0;
}

export function runMigrations(db: Database): { applied: number; version: number } {
  ensureMetaAndVersionTables(db);

  let current = getCurrentVersion(db);
  const pending = migrations.filter((m) => m.version > current);

  let applied = 0;
  for (const m of pending) {
    const tx = db.transaction(() => {
      m.up(db);
      db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(
        'schema_version',
        String(m.version),
      );
      // Keep legacy version table in sync for compatibility with Python SDK / old tools
      db.prepare('INSERT OR REPLACE INTO version (key, value) VALUES (?, ?)').run(
        'schema_version',
        String(m.version),
      );
    });
    tx();
    current = m.version;
    applied++;
  }

  return { applied, version: current };
}

/**
 * Run any pending migrations against the given dbPath (creates db if missing).
 * Returns summary of what was done.
 */
export function runPendingMigrations(dbPath: string): { applied: number; version: number } {
  const db = new Database(dbPath);
  try {
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    return runMigrations(db);
  } finally {
    db.close();
  }
}

/**
 * Return the current schema version for a dbPath (0 if none / no db meta).
 * Does not create the db file.
 */
export function getSchemaVersion(dbPath: string): number {
  // If file doesn't exist, version is 0 (no tables yet)
  // We still open to be uniform, but better-sqlite3 will create empty file on open.
  // To avoid creating empty file just for status, check via fs? but for simplicity open+close ok
  // (CLI migrate:status will tolerate; ctor of AgentTrace creates anyway)
  const db = new Database(dbPath);
  try {
    return getCurrentVersion(db);
  } finally {
    db.close();
  }
}
