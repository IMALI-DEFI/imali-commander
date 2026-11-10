import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/*
 * One SQLite file for licenses and machine activations. Kept separate
 * from every other product's database on the server.
 */
export function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS licenses (
      key TEXT PRIMARY KEY,
      email TEXT,
      plan TEXT,
      customer_id TEXT,
      subscription_id TEXT UNIQUE,
      checkout_session_id TEXT UNIQUE,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      checked_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS licenses_email_idx ON licenses (email);
    CREATE TABLE IF NOT EXISTS activations (
      id TEXT PRIMARY KEY,
      license_key TEXT NOT NULL REFERENCES licenses (key),
      label TEXT,
      created_at INTEGER NOT NULL,
      last_validated_at INTEGER,
      deactivated_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS activations_key_idx ON activations (license_key);
  `);
  return db;
}
