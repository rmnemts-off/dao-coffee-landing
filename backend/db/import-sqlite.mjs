// Offline, one-way import into an EMPTY database. Does not contact Bitrix.
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import pg from 'pg';
import { transaction, insertInquiry, refreshCustomer, payloadHash } from '../postgres-store.mjs';
import { validateLead } from '../validation.mjs';

export async function importSqlite({ filename, connectionString }) {
  const sqlite = new DatabaseSync(filename, { readOnly: true });
  let submissions, attempts, cooldown;
  try {
    sqlite.exec('BEGIN');
    if (sqlite.prepare('PRAGMA quick_check').get().quick_check !== 'ok') throw new Error('SQLite integrity failure');
    submissions = sqlite.prepare('SELECT * FROM submissions ORDER BY created_at,request_id').all();
    attempts = sqlite.prepare('SELECT * FROM delivery_attempts ORDER BY id').all();
    cooldown = sqlite.prepare('SELECT * FROM upstream_cooldown WHERE singleton=1').get();
    sqlite.exec('COMMIT');
  } finally { sqlite.close(); }
  const pool = new pg.Pool({ connectionString, max: 1, connectionTimeoutMillis: 3000 });
  pool.on('error', () => {});
  try {
    return await transaction(pool, async client => {
      await client.query('LOCK TABLE dao_website.inquiries,dao_website.crm_deliveries,dao_website.customers IN ACCESS EXCLUSIVE MODE');
      const present = (await client.query(`SELECT (SELECT count(*) FROM dao_website.inquiries) +
        (SELECT count(*) FROM dao_website.customers) AS n`)).rows[0];
      if (Number(present.n)) throw new Error('Target database must be empty');
      for (const row of submissions) {
        const lead = JSON.parse(row.payload_json), valid = validateLead(lead).lead;
        if (!valid || !isDeepStrictEqual(lead,valid) || payloadHash(lead) !== row.payload_hash) throw new Error('Invalid legacy snapshot');
        const date = new Date(row.created_at);
        const customer = (await client.query(`INSERT INTO dao_website.customers(phone_e164,first_seen_at,last_seen_at)
          VALUES($1,$2,$2) ON CONFLICT(phone_e164) DO UPDATE SET
          first_seen_at=LEAST(customers.first_seen_at,EXCLUDED.first_seen_at),
          last_seen_at=GREATEST(customers.last_seen_at,EXCLUDED.last_seen_at) RETURNING customer_id`, [lead.phone,date])).rows[0];
        await insertInquiry(client, { id: row.request_id, key: row.idempotency_key, hash: row.payload_hash,
          lead, customerId: customer.customer_id, date });
        // No historical route is invented; confirmed deliveries can still be replayed.
        const state = row.state === 'processing' ? 'uncertain' : row.state;
        await client.query(`INSERT INTO dao_website.crm_deliveries(request_id,state,created_at,updated_at,retry_at,
          crm_id,entity_type_id,contact_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
        [row.request_id,state,date,new Date(row.updated_at),new Date(row.retry_at),row.crm_id,row.entity_type_id,row.contact_id]);
        await refreshCustomer(client,row.request_id);
      }
      for (const a of attempts) {
        await client.query(`INSERT INTO dao_website.delivery_attempts(attempt_id,request_id,operation,started_at,finished_at,outcome)
          VALUES($1,$2,$3,$4,$5,$6)`, [a.id,a.request_id,a.operation,new Date(a.started_at),
          a.finished_at == null ? null : new Date(a.finished_at),a.outcome]);
      }
      if (cooldown) await client.query('INSERT INTO dao_website.upstream_cooldown VALUES(1,$1)', [new Date(cooldown.blocked_until)]);
      if (attempts.length) await client.query(`SELECT setval(pg_get_serial_sequence('dao_website.delivery_attempts','attempt_id'),$1)`,
        [attempts.reduce((max,a) => Math.max(max,a.id),0)]);
      // Verify every original key, hash, snapshot, timestamp and confirmed CRM link before COMMIT.
      const imported = (await client.query(`SELECT i.*,d.state,d.updated_at,d.retry_at,d.crm_id,d.entity_type_id,d.contact_id
        FROM dao_website.inquiries i JOIN dao_website.crm_deliveries d USING(request_id)`)).rows;
      if (imported.length !== submissions.length) throw new Error('Import count mismatch');
      const byId = new Map(imported.map(r => [r.request_id,r]));
      for (const old of submissions) {
        const n = byId.get(old.request_id);
        const ok = n && n.idempotency_key === old.idempotency_key && n.payload_hash === old.payload_hash &&
          isDeepStrictEqual(n.payload_snapshot,JSON.parse(old.payload_json)) &&
          n.state === (old.state === 'processing' ? 'uncertain' : old.state) &&
          n.received_at.getTime() === old.created_at && n.updated_at.getTime() === old.updated_at &&
          n.retry_at.getTime() === old.retry_at &&
          ['crm_id','entity_type_id','contact_id'].every(k => n[k] == null ? old[k] == null : Number(n[k]) === old[k]);
        if (!ok) throw new Error('Import verification mismatch');
      }
      const importedAttempts = (await client.query('SELECT * FROM dao_website.delivery_attempts ORDER BY attempt_id')).rows;
      if (importedAttempts.length !== attempts.length || importedAttempts.some((n,i) => {
        const a = attempts[i];
        return Number(n.attempt_id) !== a.id || n.request_id !== a.request_id || n.operation !== a.operation ||
          n.started_at.getTime() !== a.started_at || (n.finished_at?.getTime() ?? null) !== a.finished_at || n.outcome !== a.outcome;
      })) throw new Error('Attempt verification mismatch');
      return { submissions: submissions.length, attempts: attempts.length, verified: true };
    });
  } finally { await pool.end(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (!process.env.DATABASE_URL || process.argv.length !== 3) throw new Error();
    console.log(JSON.stringify(await importSqlite({ filename: process.argv[2], connectionString: process.env.DATABASE_URL })));
  } catch {
    // SQL errors may contain personal data. Do not print driver messages or row contents.
    console.error('Import failed; transaction rolled back. Verify source and empty target privately.');
    process.exitCode = 1;
  }
}
