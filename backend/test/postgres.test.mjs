import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import pg from 'pg';
import { openPostgresStore } from '../postgres-store.mjs';
import { openLeadStore } from '../store.mjs';
import { importSqlite } from '../db/import-sqlite.mjs';
import { createPersistentLeadService } from '../delivery.mjs';
import { createServer } from '../server.mjs';
import { validateLead } from '../validation.mjs';

const url = process.env.POSTGRES_TEST_URL;
const route = { portalHost:'crm.example',entityTypeId:2,categoryId:0,stageId:'NEW',sourceId:'STORE',assignedById:17 };
const body = extra => ({ schemaVersion:1,name:'Тест',phone:'+70000000001',product:'drinkx',interests:[],
  model:null,comment:'',consent:true,source:'brand-modal',...extra });
const delivered = crmId => ({ kind:'delivered',entityTypeId:2,crmId,contactId:123 });

test('PostgreSQL runtime, import and concurrency (dedicated *_test database only)', { skip: !url }, async t => {
  const admin = new pg.Pool({ connectionString:url,max:2 });
  t.after(() => admin.end());
  const database = (await admin.query('SELECT current_database() AS name')).rows[0].name;
  assert.match(database,/^dao_[a-z0-9_]*_test$/); // Never reset a production database.
  const reset = async () => {
    await admin.query('DROP SCHEMA IF EXISTS dao_website CASCADE');
    await admin.query(readFileSync(new URL('../db/postgres-schema.sql',import.meta.url),'utf8'));
  };
  const stores = async (t, options={}) => {
    const a=openPostgresStore(url,{ route,...options }), b=openPostgresStore(url,{ route,...options });
    t.after(async () => { await a.close(); await b.close(); });
    return [a,b];
  };
  await t.test('concurrent reservations share a customer, preserve context, reject conflicts and bound capacity', async t => {
    await reset(); const [a,b]=await stores(t,{ maxOutstanding:2 });
    const key=randomUUID();
    const rows=await Promise.all([a.reserve(key,body(),0),b.reserve(key,body(),0)]);
    assert.equal(rows[0].row.request_id,rows[1].row.request_id);
    assert.equal((await b.reserve(key,body({ comment:'different' }),1)).conflict,true);
    const multi=body({ product:null,interests:['coffee','water'],source:'inline',model:'Chosen' });
    await b.reserve(randomUUID(),multi,2);
    assert.equal((await a.reserve(randomUUID(),body(),3)).full,true);
    assert.equal((await admin.query('SELECT count(*) FROM dao_website.customers')).rows[0].count,'1');
    const directions=(await admin.query('SELECT direction_code FROM dao_website.inquiry_directions ORDER BY direction_code')).rows.map(r=>r.direction_code);
    assert.deepEqual(directions,['coffee','drinkx','water']);
    const inquiry=(await admin.query("SELECT * FROM dao_website.inquiries WHERE source='inline'")).rows[0];
    assert.equal(inquiry.source_block,'contact'); assert.equal(inquiry.model_snapshot,'Chosen');
    assert.deepEqual(inquiry.payload_snapshot,multi);
  });
  await t.test('two OS processes can claim only one send for the same persisted inquiry', async t => {
    await reset(); const [a]=await stores(t);
    const { row }=await a.reserve(randomUUID(),body(),Date.now());
    const script=`import {openPostgresStore} from ${JSON.stringify(new URL('../postgres-store.mjs',import.meta.url).href)};
      const s=openPostgresStore(process.env.POSTGRES_TEST_URL,{route:JSON.parse(process.env.DAO_TEST_ROUTE)});
      try { const c=await s.claim(process.env.DAO_TEST_ID,'send',Date.now()); console.log(c?.owner?'claimed':'pending'); }
      finally { await s.close(); }`;
    const child=()=>new Promise((resolve,reject)=>{
      const c=spawn(process.execPath,['--input-type=module','-e',script],{ env:{...process.env,DAO_TEST_ROUTE:JSON.stringify(route),DAO_TEST_ID:row.request_id} });
      let out=''; c.stdout.on('data',b=>out+=b); c.stderr.resume(); c.on('error',reject);
      c.on('exit',code=>code===0?resolve(out.trim()):reject(new Error('Child failed')));
    });
    assert.deepEqual((await Promise.all([child(),child()])).sort(),['claimed','pending']);
    assert.equal((await admin.query('SELECT count(*) FROM dao_website.delivery_attempts')).rows[0].count,'1');
  });
  await t.test('lease takeover fences old worker, uncertain results never send again, cooldown survives stale finish', async t => {
    await reset(); const [a,b]=await stores(t);
    const { row }=await a.reserve(randomUUID(),body(),0);
    const first=await a.claim(row.request_id,'send',0);
    assert.equal(await b.claim(row.request_id,'reconcile',1),null);
    const next=await b.claim(row.request_id,'reconcile',61_000);
    await assert.rejects(a.finish(row.request_id,first,{kind:'rejected',retryAfter:60},62_000));
    await b.finish(row.request_id,next,{kind:'uncertain'},63_000);
    assert.equal((await a.claim(row.request_id,'send',200_000)).current.state,'uncertain');
    const another=(await b.reserve(randomUUID(),body(),64_000)).row;
    assert.equal((await b.claim(another.request_id,'send',68_000)).blockedUntil,122_000);
    const claim=await b.claim(row.request_id,'reconcile',200_000);
    await b.finish(row.request_id,claim,delivered(88),200_001);
    assert.equal((await a.get(row.request_id)).crm_id,88);
    assert.equal((await a.claim(row.request_id,'send',300_000)).current.state,'delivered');
  });
  await t.test('failed local commit after remote success recovers through read-only reconciliation', async t => {
    await reset(); const [a]=await stores(t); let now=0,sends=0,reads=0,fail=true;
    const service=createPersistentLeadService({store:{...a,finish:async(...args)=>{
      if(fail){fail=false;throw new Error('simulated lost COMMIT response');} return a.finish(...args);
    }},now:()=>now,send:async()=>{sends++;return delivered(91);},reconcile:async()=>{reads++;return delivered(91);}});
    const key=randomUUID(); assert.equal((await service.submit(body(),key)).body.code,'DELIVERY_UNCERTAIN');
    now=61_000; assert.equal((await service.submit(body(),key)).status,200);
    assert.equal(sends,1); assert.equal(reads,1);
  });
  await t.test('offline import verifies snapshots, keys, timestamps and attempts; restart replays without CRM', async t => {
    await reset(); const dir=mkdtempSync(join(tmpdir(),'dao-pg-import-')); t.after(()=>rmSync(dir,{recursive:true,force:true}));
    const filename=join(dir,'leads.sqlite'), legacy=openLeadStore(filename);
    const key=randomUUID(), lead=body();
    const r=legacy.reserve(key,lead,1000).row;
    legacy.finish(r.request_id,legacy.claim(r.request_id,'send',1001),delivered(101),1002);
    const uncertain=legacy.reserve(randomUUID(),body({comment:'Interrupted'}),2000).row;
    legacy.claim(uncertain.request_id,'send',2001); legacy.close();
    assert.deepEqual(await importSqlite({filename,connectionString:url}),{submissions:2,attempts:2,verified:true});
    await assert.rejects(importSqlite({filename,connectionString:url}));
    const [a]=await stores(t); let sends=0;
    const service=createPersistentLeadService({store:a,send:async()=>{sends++;return delivered(102);}});
    assert.equal((await service.submit(lead,key)).body.requestId,r.request_id); assert.equal(sends,0);
    assert.equal((await a.get(uncertain.request_id)).state,'uncertain');
    assert.equal((await a.claim(uncertain.request_id,'reconcile',100_000)).current.target_route,null);
    assert.equal((await a.get(r.request_id)).payload_hash,r.payload_hash);
  });
  await t.test('HTTP uses PostgreSQL, duplicate success survives API restart; unavailable schema fails readiness', async t => {
    await reset(); let sends=0;
    const env={DATABASE_URL:url,APP_ORIGIN:'https://dao.example',BITRIX_WEBHOOK_URL:'https://crm.example/rest/1/mock-secret/',
      BITRIX_ENTITY_TYPE_ID:'2',BITRIX_CATEGORY_ID:'0',BITRIX_STAGE_ID:'NEW',BITRIX_SOURCE_ID:'STORE',BITRIX_ASSIGNED_BY_ID:'17'};
    const start=async()=>{
      const server=createServer({env,send:async()=>{sends++;return delivered(120);}});
      await new Promise(r=>server.listen(0,'127.0.0.1',r));
      return {server,base:`http://127.0.0.1:${server.address().port}`};
    };
    let {server,base}=await start(); const key=randomUUID();
    const send=()=>fetch(base+'/api/leads',{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':key},body:JSON.stringify(body())});
    assert.equal((await fetch(base+'/readyz')).status,200);
    const first=await (await send()).json(); assert.equal(first.ok,true);
    await server.shutdown(); ({server,base}=await start()); t.after(()=>server.shutdown());
    assert.deepEqual(await (await send()).json(),first); assert.equal(sends,1);
    await admin.query('ALTER SCHEMA dao_website RENAME TO dao_unavailable');
    try {
      assert.equal((await fetch(base+'/readyz')).status,503);
      assert.equal((await send()).status,503); assert.equal(sends,1);
    } finally { await admin.query('ALTER SCHEMA dao_unavailable RENAME TO dao_website'); }
  });
  await t.test('route changes cannot silently redirect a stored inquiry to another CRM', async t => {
    await reset(); const [a]=await stores(t);
    const row=(await a.reserve(randomUUID(),body(),0)).row;
    const b=openPostgresStore(url,{route:{...route,assignedById:99}}); t.after(()=>b.close());
    assert.equal((await b.claim(row.request_id,'send',1)).current.state,'received');
    assert.equal((await admin.query('SELECT count(*) FROM dao_website.delivery_attempts')).rows[0].count,'0');
  });
});

test('invalid JSONB text is rejected before storage; valid astral Unicode stays intact',()=>{
  for(const comment of ['nul\0text','bad\ud800']) assert.ok(validateLead(body({comment})).fieldErrors.comment);
  assert.equal(validateLead(body({comment:'Кофе ☕ 😀'})).lead.comment,'Кофе ☕ 😀');
});
