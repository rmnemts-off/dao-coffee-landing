import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createServer } from '../server.mjs';

const lead = { schemaVersion: 1, name: 'Тест', phone: '+70000000001', product: 'drinkx', interests: [], model: 'S100', comment: '', consent: true, source: 'brand-modal' };
async function start(t, options = {}) {
  const server = createServer({ env: {}, send: async () => ({ kind: 'delivered' }), ...options });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const post = (body = lead, headers = {}) => fetch(`${origin}/api/leads`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { origin, post, server };
}

test('POST contract, no-store, method restriction, health and secret paths', async t => {
  const { post, origin } = await start(t);
  const response = await post();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const result = await response.json();
  assert.equal(result.ok, true);
  assert.match(result.requestId, /^[0-9a-f-]{36}$/);
  assert.equal((await fetch(`${origin}/api/leads`)).status, 405);
  assert.equal((await fetch(`${origin}/.env`)).status, 404);
  assert.equal((await fetch(`${origin}/backend/server.mjs`)).status, 404);
  assert.equal((await fetch(`${origin}/healthz`)).status, 200);
});

test('validates input and protects JSON content, origin and body size before delivery', async t => {
  let calls = 0;
  const { post, origin } = await start(t, { send: async () => { calls++; return { kind: 'delivered' }; }, serviceOptions: { perIpLimit: 20 } });
  const invalid = await post({ ...lead, consent: 'true' });
  assert.equal(invalid.status, 400);
  assert.ok((await invalid.json()).fieldErrors.consent);
  assert.equal((await post(lead, { 'Content-Type': 'text/plain' })).status, 400);
  assert.equal((await post(lead, { Origin: 'https://other.example' })).status, 403);
  assert.equal((await post(lead, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal((await post({ ...lead, comment: 'a'.repeat(9000) })).status, 413);
  const malformed = await fetch(`${origin}/api/leads`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' });
  assert.equal(malformed.status, 400);
  assert.equal(calls, 0);
  assert.equal((await post(lead, { Origin: origin })).status, 200);
});

test('chunked oversized body receives a real 413 response', async t => {
  const { origin } = await start(t, { send: () => { assert.fail('no delivery'); } });
  const result = await new Promise((resolve, reject) => {
    const req = http.request(`${origin}/api/leads`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked' } }, res => {
      let body = ''; res.on('data', c => { body += c; }); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
    });
    req.on('error', reject); req.write('x'.repeat(5000)); req.end('x'.repeat(5000));
  });
  assert.equal(result.status, 413);
  assert.equal(result.body.code, 'BODY_TOO_LARGE');
});

test('slow request body times out without sending', async t => {
  const { origin } = await start(t, { bodyTimeoutMs: 20, send: () => { assert.fail('no delivery'); } });
  const status = await new Promise((resolve, reject) => {
    const req = http.request(`${origin}/api/leads`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': '100' } }, res => {
      res.resume(); res.on('end', () => { resolve(res.statusCode); req.destroy(); });
    });
    req.on('error', reject); req.write('{');
  });
  assert.equal(status, 408);
});

test('spoofed forwarding headers do not bypass rate limits by default', async t => {
  const { post } = await start(t, { serviceOptions: { perIpLimit: 1 } });
  assert.equal((await post(lead, { 'X-Real-IP': '192.0.2.1' })).status, 200);
  const limited = await post(lead, { 'X-Real-IP': '192.0.2.2', 'X-Forwarded-For': '192.0.2.3' });
  assert.equal(limited.status, 429); assert.equal(limited.headers.get('retry-after'), '60');
});

test('explicitly trusted loopback proxy provides distinct client addresses', async t => {
  const { post } = await start(t, { env: { APP_ORIGIN: 'https://dao.example', TRUST_LOOPBACK_PROXY: '1' }, serviceOptions: { perIpLimit: 1 } });
  assert.equal((await post(lead, { 'X-Real-IP': '192.0.2.1', Origin: 'https://dao.example' })).status, 200);
  assert.equal((await post(lead, { 'X-Real-IP': '192.0.2.2' })).status, 200);
  assert.equal((await post(lead, { 'X-Real-IP': '192.0.2.1' })).status, 429);
});

test('delivery failures return safe JSON; unconfigured server never reports success', async t => {
  for (const [kind, status, code] of [['unconfigured', 503, 'DELIVERY_UNAVAILABLE'], ['rejected', 502, 'DELIVERY_FAILED'], ['uncertain', 502, 'DELIVERY_UNCERTAIN']]) {
    const { post } = await start(t, { send: async () => ({ kind, description: 'private upstream error' }) });
    const response = await post();
    assert.equal(response.status, status);
    assert.deepEqual(await response.json(), { ok: false, code });
  }
});

test('invalid traffic from separate clients does not exhaust the global delivery budget', async t => {
  let calls = 0;
  const { post } = await start(t, {
    env: { APP_ORIGIN: 'https://dao.example', TRUST_LOOPBACK_PROXY: '1' },
    serviceOptions: { perIpLimit: 1, globalLimit: 1 },
    send: async () => { calls++; return { kind: 'delivered' }; },
  });
  for (let i = 1; i <= 35; i++) {
    const headers = { 'X-Real-IP': `192.0.2.${i}` };
    if (i % 2) headers.Origin = 'https://other.example';
    assert.equal((await post({ ...lead, consent: false }, headers)).status, i % 2 ? 403 : 400);
  }
  const first = await post(lead, { 'X-Real-IP': '192.0.2.100' });
  assert.equal(first.status, 200);
  const duplicate = await post(lead, { 'X-Real-IP': '192.0.2.101' });
  assert.deepEqual(await duplicate.json(), await first.json());
  assert.equal((await post({ ...lead, comment: 'new' }, { 'X-Real-IP': '192.0.2.102' })).status, 429);
  assert.equal(calls, 1);
});

test('readiness checks only local configuration and draining, without a Bitrix request', async t => {
  const configured = { NODE_ENV: 'production', APP_ORIGIN: 'https://dao.example', BITRIX_WEBHOOK_URL: 'https://crm.example/rest/1/mock-secret/', BITRIX_ENTITY_TYPE_ID: '1', BITRIX_ASSIGNED_BY_ID: '1', BITRIX_STAGE_ID: 'NEW' };
  for (const env of [{}, { ...configured, BITRIX_WEBHOOK_URL: 'invalid' }, { ...configured, APP_ORIGIN: '' }, { ...configured, APP_ORIGIN: 'http://dao.example' }, configured]) {
    // No injected sender: only configuration is checked, never CRM creation.
    const { server, origin } = await start(t, { env, send: undefined });
    const ready = await fetch(`${origin}/readyz`);
    assert.equal(ready.status, env === configured ? 200 : 503);
    assert.equal(ready.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await ready.json(), env === configured ? { ok: true } : { ok: false, code: 'NOT_READY' });
    server.beginDrain();
    assert.equal((await fetch(`${origin}/readyz`)).status, 503);
    assert.equal((await fetch(`${origin}/healthz`)).status, 200);
  }
});

test('legacy Telegram-only configuration cannot accept or send a production lead', async t => {
  const { post, origin } = await start(t, { send: undefined,
    env: { NODE_ENV: 'production', APP_ORIGIN: 'https://dao.example', TELEGRAM_BOT_TOKEN: '1:legacy', TELEGRAM_CHAT_ID: '123' },
  });
  assert.equal((await fetch(`${origin}/readyz`)).status, 503);
  const result = await post();
  assert.equal(result.status, 503);
  assert.deepEqual(await result.json(), { ok: false, code: 'DELIVERY_UNAVAILABLE' });
});

test('draining rejects new deliveries while an admitted delivery finishes', async t => {
  let complete;
  let started;
  const sending = new Promise(resolve => { started = resolve; });
  const { server, origin, post } = await start(t, { send: () => {
    started();
    return new Promise(resolve => { complete = resolve; });
  } });
  const pending = post();
  await sending;
  server.beginDrain();
  assert.equal((await fetch(`${origin}/readyz`)).status, 503);
  const rejected = await post({ ...lead, comment: 'new' });
  assert.equal(rejected.status, 503);
  assert.equal(rejected.headers.get('connection'), 'close');
  const stopped = server.shutdown();
  assert.equal(server.shutdown(), stopped);
  complete({ kind: 'delivered' });
  assert.equal((await pending).status, 200);
  assert.equal(await stopped, true);
});

test('shutdown waits for Bitrix after the client disconnects and HTTP server closes', async t => {
  let complete;
  let started;
  const sending = new Promise(resolve => { started = resolve; });
  const { server, origin } = await start(t, { send: () => {
    started();
    return new Promise(resolve => { complete = resolve; });
  } });
  const req = http.request(`${origin}/api/leads`, { method: 'POST', headers: { 'Content-Type': 'application/json' } });
  req.on('error', () => {});
  req.end(JSON.stringify(lead));
  await sending;
  const disconnected = new Promise(resolve => req.once('close', resolve));
  req.destroy();
  await disconnected;
  const closed = once(server, 'close');
  let settled = false;
  const stopped = server.shutdown().then(result => { settled = true; return result; });
  await closed;
  assert.equal(settled, false, 'closing the HTTP listener must not abandon an outbound send');
  complete({ kind: 'delivered' });
  assert.equal(await stopped, true);
});

test('shutdown deadline ends the drain when a handler never settles', async t => {
  let complete;
  let started;
  const sending = new Promise(resolve => { started = resolve; });
  const { server, post } = await start(t, { send: () => {
    started();
    return new Promise(resolve => { complete = resolve; });
  } });
  const pending = post().catch(() => null);
  await sending;
  assert.equal(await server.shutdown({ timeoutMs: 20 }), false);
  assert.equal(await pending, null);
  complete({ kind: 'delivered' });
});
