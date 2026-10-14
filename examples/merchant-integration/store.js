import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
export class Store {
  constructor(path) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    if (path !== ':memory:') chmodSync(path, 0o600);
    this.db.exec('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS records (id TEXT PRIMARY KEY, value TEXT NOT NULL);');
  }
  get(id) { const row = this.db.prepare('SELECT value FROM records WHERE id=?').get(id); return row ? JSON.parse(row.value) : undefined; }
  put(id, value) { this.db.prepare('INSERT INTO records VALUES (?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(id, JSON.stringify(value)); }
  find(predicate) { return this.db.prepare('SELECT value FROM records').all().map(row => JSON.parse(row.value)).find(predicate); }
  close() { this.db.close(); }
}
