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
  return { origin, post };
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
