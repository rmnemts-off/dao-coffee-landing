import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname, resolve, relative, sep, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

// Local single-host journal, outside the public web root. No credentials/IPs are stored.
export function openLeadStore(filename = ':memory:', { maxOutstanding = 1000 } = {}) {
  if (filename !== ':memory:') {
    filename = resolve(filename);
    const publicRoot = fileURLToPath(new URL('../site/', import.meta.url));
    const rel = relative(publicRoot, filename);
    if (!(rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel))) throw new Error('Lead database must be outside site/');
    mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
  }
  const db = new DatabaseSync(filename);
  if (filename !== ':memory:') chmodSync(filename, 0o600);
  db.exec(`PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
    CREATE TABLE IF NOT EXISTS submissions (
      request_id TEXT PRIMARY KEY, idempotency_key TEXT NOT NULL UNIQUE,
      payload_hash TEXT NOT NULL, payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
      state TEXT NOT NULL CHECK(state IN ('received','processing','delivered','rejected','uncertain','unconfigured')),
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, retry_at INTEGER NOT NULL DEFAULT 0,
      crm_id INTEGER, entity_type_id INTEGER, contact_id INTEGER
    );
    CREATE TABLE IF NOT EXISTS delivery_attempts (
      id INTEGER PRIMARY KEY, request_id TEXT NOT NULL REFERENCES submissions(request_id),
      operation TEXT NOT NULL CHECK(operation IN ('send','reconcile')),
      started_at INTEGER NOT NULL, finished_at INTEGER, outcome TEXT
    );
    CREATE TABLE IF NOT EXISTS delivery_lock (
      singleton INTEGER PRIMARY KEY CHECK(singleton=1), owner TEXT NOT NULL, expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS submissions_state ON submissions(state, updated_at);
    PRAGMA user_version=1;`);
  const get = id => db.prepare('SELECT * FROM submissions WHERE request_id=?').get(id);
  const transaction = operation => {
    db.exec('BEGIN IMMEDIATE');
    try { const result = operation(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  };
  return {
    reserve(key, lead, now) {
      const { source: _source, ...identity } = lead;
      const hash = createHash('sha256').update(JSON.stringify(identity)).digest('hex');
      return transaction(() => {
        const existing = db.prepare('SELECT * FROM submissions WHERE idempotency_key=?').get(key);
        if (existing) return { row: existing, conflict: existing.payload_hash !== hash, fresh: false };
        const outstanding = db.prepare("SELECT count(*) AS count FROM submissions WHERE state!='delivered'").get().count;
        if (outstanding >= maxOutstanding) return { full: true };
        const id = randomUUID();
        db.prepare(`INSERT INTO submissions(request_id,idempotency_key,payload_hash,payload_json,state,created_at,updated_at)
          VALUES(?,?,?,?,'received',?,?)`).run(id, key, hash, JSON.stringify(lead), now, now);
        return { row: get(id), fresh: true, conflict: false };
      });
    },
    claim(id, operation, now, leaseMs = 60_000) {
      return transaction(() => {
        const current = get(id);
        const allowed = operation === 'send' ? ['received', 'rejected', 'unconfigured'] : ['processing', 'uncertain'];
        if (!current || !allowed.includes(current.state) || current.retry_at > now) return { current };
        const lock = db.prepare('SELECT * FROM delivery_lock WHERE singleton=1').get();
        if (lock && lock.expires_at > now) return null;
        const owner = randomUUID();
        db.prepare('INSERT OR REPLACE INTO delivery_lock VALUES(1,?,?)').run(owner, now + leaseMs);
        const attempt = Number(db.prepare('INSERT INTO delivery_attempts(request_id,operation,started_at) VALUES(?,?,?)').run(id, operation, now).lastInsertRowid);
        db.prepare("UPDATE submissions SET state='processing',updated_at=? WHERE request_id=?").run(now, id);
        return { owner, attempt };
      });
    },
    finish(id, claim, result, now) {
      const kind = ['delivered', 'rejected', 'unconfigured'].includes(result?.kind) ? result.kind : 'uncertain';
      transaction(() => {
        const lock = db.prepare('SELECT owner FROM delivery_lock WHERE singleton=1').get();
        if (lock?.owner !== claim.owner) throw new Error('Delivery lease expired');
        db.prepare(`UPDATE submissions SET state=?,updated_at=?,retry_at=?,crm_id=?,entity_type_id=?,contact_id=? WHERE request_id=?`)
          .run(kind, now, now + Math.max(5, Math.min(3600, result?.retryAfter || 5)) * 1000,
            result?.crmId ?? null, result?.entityTypeId ?? null, result?.contactId ?? null, id);
        db.prepare('UPDATE delivery_attempts SET finished_at=?,outcome=? WHERE id=?').run(now, kind, claim.attempt);
        db.prepare('DELETE FROM delivery_lock WHERE owner=?').run(claim.owner);
      });
      return get(id);
    },
    get,
    list: () => db.prepare('SELECT request_id,state,created_at,updated_at,crm_id,entity_type_id,contact_id FROM submissions ORDER BY created_at DESC LIMIT 100').all(),
    close: () => db.close(),
  };
}
