// Operator tool: local status listing, or read-only CRM reconciliation. Never sends/creates a lead.
import { openLeadStore } from './store.mjs';
import { openPostgresStore, deliveryRoute } from './postgres-store.mjs';
import { createBitrixReconciler } from './bitrix.mjs';
import { validIdempotencyKey } from './delivery.mjs';

let store;
try {
  if (!process.env.DATABASE_URL && (!process.env.LEADS_DB_PATH || process.env.LEADS_DB_PATH === ':memory:')) throw new Error();
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== '--reconcile' || !validIdempotencyKey(args[1]))) throw new Error();
  store = process.env.DATABASE_URL ? openPostgresStore(process.env.DATABASE_URL, { route: deliveryRoute(process.env) }) : openLeadStore(process.env.LEADS_DB_PATH);
  if (!args.length) console.log(JSON.stringify(await store.list(), null, 2));
  else {
    const row = await store.get(args[1]);
    if (!row || !['processing', 'uncertain'].includes(row.state)) {
      console.log(JSON.stringify({ requestId: args[1], result: 'nothing_to_reconcile' }));
    } else {
      const claim = await store.claim(row.request_id, 'reconcile', Date.now());
      if (!claim || claim.current || claim.blockedUntil) console.log(JSON.stringify({ requestId: row.request_id, result: 'pending' }));
      else {
        const result = await createBitrixReconciler({ env: process.env })(row.request_id);
        const finished = await store.finish(row.request_id, claim, result.kind === 'delivered' ? result : { kind: 'uncertain' }, Date.now());
        console.log(JSON.stringify({ requestId: row.request_id, state: finished.state, crmId: finished.crm_id }));
      }
    }
  }
} catch {
  console.error('Journal unavailable. Set DATABASE_URL (or LEADS_DB_PATH for local legacy inspection). Usage: npm run journal:leads [-- --reconcile <request-id>]');
  process.exitCode = 1;
} finally { await store?.close(); }
