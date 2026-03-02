import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';

const SCHEMA_PATH = path.resolve(process.cwd(), 'worker/schema.sql');

function openDb() {
  return new DatabaseSync(':memory:');
}

function applySchema(db) {
  const sql = fs.readFileSync(SCHEMA_PATH, 'utf8');
  db.exec(sql);
}

describe('worker schema bootstrap', () => {
  it('applies cleanly to a fresh database', () => {
    const db = openDb();
    expect(() => applySchema(db)).not.toThrow();
    db.close();
  });

  it('is idempotent: re-run produces no errors', () => {
    const db = openDb();
    applySchema(db);
    expect(() => applySchema(db)).not.toThrow();
    db.close();
  });

  it('creates all required tables', () => {
    const db = openDb();
    applySchema(db);
    const rows = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
    const names = rows.map((r) => r.name);
    expect(names).toContain('key_types');
    expect(names).toContain('users');
    expect(names).toContain('key_store');
    expect(names).toContain('entries');
    expect(names).toContain('entry_history');
    db.close();
  });

  it('creates all required indexes', () => {
    const db = openDb();
    applySchema(db);
    const rows = db.prepare("SELECT name FROM sqlite_master WHERE type='index' ORDER BY name").all();
    const names = rows.map((r) => r.name);
    expect(names).toContain('idx_key_store_user');
    expect(names).toContain('idx_entries_user');
    expect(names).toContain('idx_history_entry');
    db.close();
  });

  it('seeds exactly 5 key_types rows', () => {
    const db = openDb();
    applySchema(db);
    const rows = db.prepare('SELECT type FROM key_types ORDER BY type').all();
    expect(rows).toHaveLength(5);
    const types = rows.map((r) => r.type);
    expect(types).toContain('emergency');
    expect(types).toContain('own_private');
    expect(types).toContain('own_public');
    expect(types).toContain('peer_public');
    expect(types).toContain('umk');
    db.close();
  });

  it('enforces FK from key_store.type to key_types', () => {
    const db = openDb();
    applySchema(db);
    db.exec(`INSERT INTO users (user_id, created_at) VALUES ('u1', 'now')`);
    expect(() => {
      db.exec(`INSERT INTO key_store (key_id, user_id, type, created_at) VALUES ('k1', 'u1', 'bogus_type', 'now')`);
    }).toThrow();
    db.close();
  });
});
