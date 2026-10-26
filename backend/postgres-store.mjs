import pg from 'pg';
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { bitrixConfig } from './bitrix.mjs';

export function deliveryRoute(env) {
  const config = bitrixConfig(env);
  if (!config) return null;
  const { webhookUrl, ...route } = config;
  return { ...route, categoryId: route.categoryId ?? null, portalHost: new URL(webhookUrl).hostname };
}

export const payloadHash = lead => {
  const { source: _source, ...identity } = lead;
  return createHash('sha256').update(JSON.stringify(identity)).digest('hex');
};
const positiveId = value => Number.isSafeInteger(value) && value > 0;
const number = value => {
  if (value == null) return null;
  const result = Number(value);
  if (!Number.isSafeInteger(result)) throw new Error('Unsafe database integer');
  return result;
};
const milliseconds = value => value == null ? 0 : new Date(value).getTime();
const rowQuery = `SELECT i.request_id,i.idempotency_key,i.payload_hash,i.payload_snapshot,
  d.*, i.received_at FROM dao_website.inquiries i
  JOIN dao_website.crm_deliveries d USING(request_id)`;
function convert(row) {
  if (!row) return undefined;
  return { ...row, payload_json: JSON.stringify(row.payload_snapshot),
    created_at: milliseconds(row.created_at), updated_at: milliseconds(row.updated_at),
    retry_at: milliseconds(row.retry_at), lease_until: milliseconds(row.lease_until),
    crm_id: number(row.crm_id), contact_id: number(row.contact_id), generation: number(row.generation) };
}

export async function transaction(pool, operation) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await operation(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
}

// One database is authoritative. Never fall back to SQLite if PostgreSQL fails.
export function openPostgresStore(connectionString, { maxOutstanding = 1000, route = null } = {}) {
  const pool = new pg.Pool({ connectionString, max: 4, connectionTimeoutMillis: 3000,
    idleTimeoutMillis: 10_000, statement_timeout: 5000, idle_in_transaction_session_timeout: 10_000,
    application_name: 'dao-coffee-api' });
  // The next operation/readiness check reports failure without logging credentials or payloads.
  pool.on('error', () => {});
  const get = async (id, client = pool) => convert((await client.query(`${rowQuery} WHERE i.request_id=$1`, [id])).rows[0]);
  const lock = async client => (await client.query('SELECT * FROM dao_website.dispatch_lock WHERE singleton=1 FOR UPDATE')).rows[0];
  return {
    async ready() {
      const r = await pool.query('SELECT version,name FROM dao_website.schema_migrations ORDER BY version');
      return r.rows.length === 1 && r.rows[0].version === 1 && r.rows[0].name === 'Persistent inquiries and CRM delivery journal';
    },
    reserve(key, lead, now) {
      return transaction(pool, async client => {
        await lock(client); // Serialize capacity checks and insertion across API processes.
        const existing = convert((await client.query(`${rowQuery} WHERE i.idempotency_key=$1`, [key])).rows[0]);
        const hash = payloadHash(lead);
        if (existing) return { row: existing, conflict: existing.payload_hash !== hash, fresh: false };
        const count = Number((await client.query("SELECT count(*) FROM dao_website.crm_deliveries WHERE state<>'delivered'")).rows[0].count);
        if (count >= maxOutstanding) return { full: true };
        const date = new Date(now);
        const customer = (await client.query(`INSERT INTO dao_website.customers(phone_e164,first_seen_at,last_seen_at)
          VALUES($1,$2,$2) ON CONFLICT(phone_e164) DO UPDATE SET
          first_seen_at=LEAST(customers.first_seen_at,EXCLUDED.first_seen_at),
          last_seen_at=GREATEST(customers.last_seen_at,EXCLUDED.last_seen_at) RETURNING customer_id`, [lead.phone,date])).rows[0];
        const id = randomUUID();
        await insertInquiry(client, { id, key, hash, lead, customerId: customer.customer_id, date });
        await client.query(`INSERT INTO dao_website.crm_deliveries(request_id,target_route,created_at,updated_at)
          VALUES($1,$2,$3,$3)`, [id,route,date]);
        return { row: await get(id,client), fresh: true, conflict: false };
      });
    },
    claim(id, operation, now, leaseMs = 60_000) {
      if (!['send','reconcile'].includes(operation)) throw new Error('Invalid journal operation');
      return transaction(pool, async client => {
        const dispatch = await lock(client);
        const current = await get(id,client);
        const allowed = operation === 'send' ? ['received','rejected','unconfigured'] : ['processing','uncertain'];
        if (!current || !allowed.includes(current.state) || current.retry_at > now) return { current };
        // Legacy unknown routes and configuration changes need operator review, never a guessed destination.
        if (!route || !isDeepStrictEqual(current.target_route,route)) return { current };
        const cooldown = (await client.query('SELECT blocked_until FROM dao_website.upstream_cooldown WHERE singleton=1')).rows[0];
        if (milliseconds(cooldown?.blocked_until) > now) return { current, blockedUntil: milliseconds(cooldown.blocked_until) };
        if (milliseconds(dispatch.expires_at) > now) return null;
        const owner = randomUUID(), generation = current.generation + 1;
        await client.query('UPDATE dao_website.dispatch_lock SET owner=$1,expires_at=$2 WHERE singleton=1', [owner,new Date(now+leaseMs)]);
        const attempt = (await client.query(`INSERT INTO dao_website.delivery_attempts(request_id,operation,claim_token,started_at)
          VALUES($1,$2,$3,$4) RETURNING attempt_id`, [id,operation,owner,new Date(now)])).rows[0];
        await client.query(`UPDATE dao_website.crm_deliveries SET state='processing',operation=$2,
          claim_token=$3,lease_until=$4,generation=$5,updated_at=$6 WHERE request_id=$1`,
        [id,operation,owner,new Date(now+leaseMs),generation,new Date(now)]);
        return { owner, attempt: number(attempt.attempt_id), generation };
      });
    },
    async finish(id, claim, result, now) {
      let kind = ['delivered','rejected','unconfigured'].includes(result?.kind) ? result.kind : 'uncertain';
      if (kind === 'delivered' && (!positiveId(result.crmId) || ![1,2].includes(result.entityTypeId))) kind = 'uncertain';
      const retryAt = new Date(now + Math.max(5,Math.min(3600,result?.retryAfter || 5))*1000);
      if (kind === 'rejected') {
        await pool.query(`INSERT INTO dao_website.upstream_cooldown VALUES(1,$1)
          ON CONFLICT(singleton) DO UPDATE SET blocked_until=GREATEST(upstream_cooldown.blocked_until,EXCLUDED.blocked_until)`, [retryAt]);
      }
      return transaction(pool, async client => {
        const dispatch = await lock(client), current = await get(id,client);
        if (dispatch.owner !== claim.owner || current?.claim_token !== claim.owner || current.generation !== claim.generation ||
            milliseconds(dispatch.expires_at) <= now) throw new Error('Delivery lease expired');
        if (current.operation === 'reconcile' && kind !== 'delivered') kind = 'uncertain';
        await client.query(`UPDATE dao_website.crm_deliveries SET state=$2,updated_at=$3,retry_at=$4,
          crm_id=$5,entity_type_id=$6,contact_id=$7,operation=NULL,claim_token=NULL,lease_until=NULL WHERE request_id=$1`,
        [id,kind,new Date(now),retryAt,positiveId(result?.crmId) ? result.crmId : null,
          [1,2].includes(result?.entityTypeId) ? result.entityTypeId : null, positiveId(result?.contactId) ? result.contactId : null]);
        await client.query(`UPDATE dao_website.delivery_attempts SET finished_at=$2,outcome=$3
          WHERE attempt_id=$1 AND request_id=$4 AND claim_token=$5`, [claim.attempt,new Date(now),kind,id,claim.owner]);
        await client.query('UPDATE dao_website.dispatch_lock SET owner=NULL,expires_at=NULL WHERE singleton=1');
        // Customer mapping remains conservative: multiple historic contacts => ambiguous.
        await refreshCustomer(client,id);
        return get(id,client);
      });
    },
    get,
    async list() {
      const rows = (await pool.query(`${rowQuery} ORDER BY (d.state='delivered'),d.created_at ASC LIMIT 1100`)).rows;
      return rows.map(convert).map(({ request_id,state,created_at,updated_at,crm_id,entity_type_id,contact_id }) =>
        ({ request_id,state,created_at,updated_at,crm_id,entity_type_id,contact_id }));
    },
    close: () => pool.end(),
  };
}

export async function insertInquiry(client, { id,key,hash,lead,customerId,date }) {
  await client.query(`INSERT INTO dao_website.inquiries(request_id,customer_id,idempotency_key,payload_hash,
    payload_snapshot,submitted_name,submitted_phone,product_code,model_snapshot,message_snapshot,source,consent,received_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
  [id,customerId,key,hash,lead,lead.name,lead.phone,lead.product,lead.model,lead.comment,lead.source,lead.consent,date]);
  const directions = lead.product ? [lead.product] : lead.interests.filter(x => x !== 'undecided');
  for (const [position,direction] of directions.entries()) {
    await client.query('INSERT INTO dao_website.inquiry_directions VALUES($1,$2,$3)', [id,direction,position]);
  }
}

export async function refreshCustomer(client, id) {
  await client.query(`WITH ids AS (
    SELECT i.customer_id,count(DISTINCT d.contact_id) AS n,min(d.contact_id) AS contact
    FROM dao_website.inquiries i JOIN dao_website.crm_deliveries d USING(request_id)
    WHERE i.customer_id=(SELECT customer_id FROM dao_website.inquiries WHERE request_id=$1)
    GROUP BY i.customer_id)
    UPDATE dao_website.customers c SET crm_contact_id=CASE WHEN ids.n=1 THEN ids.contact END,
    crm_match_state=CASE WHEN ids.n=1 THEN 'matched' WHEN ids.n>1 THEN 'ambiguous' ELSE 'unresolved' END
    FROM ids WHERE c.customer_id=ids.customer_id`, [id]);
}
