import http from 'node:http';
import { isIP } from 'node:net';
import { pathToFileURL } from 'node:url';
import { createLeadService, failure } from './leads.mjs';
import { bitrixConfig, createBitrixSender, createBitrixReconciler } from './bitrix.mjs';
import { openLeadStore } from './store.mjs';
import { createPersistentLeadService } from './delivery.mjs';

function parseOrigin(value) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password &&
      url.pathname === '/' && !url.search && !url.hash ? url.origin : null;
  } catch { return null; }
}

function reply(response, result) {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(result.status, {
    'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff', ...(result.status === 429 ? { 'Retry-After': '60' } : {}),
  }).end(JSON.stringify(result.body));
}

function readBody(request, maxBytes, timeoutMs) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let chunks = [];
    const timer = setTimeout(() => finish(failure(408, 'REQUEST_TIMEOUT')), timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      request.off('data', data); request.off('end', end); request.off('error', aborted); request.off('aborted', aborted);
    };
    function finish(error, body) {
      cleanup(); chunks = [];
      if (error) { request.resume(); reject(error); } else resolve(body);
    }
    function data(chunk) {
      size += chunk.length;
      if (size > maxBytes) finish(failure(413, 'BODY_TOO_LARGE'));
      else chunks.push(chunk);
    }
    function end() {
      try {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
        finish(null, JSON.parse(text));
      } catch { finish(failure(400, 'VALIDATION_ERROR', { fieldErrors: { form: 'Некорректный JSON.' } })); }
    }
    function aborted() { finish(failure(400, 'INVALID_REQUEST')); }
    request.on('data', data); request.on('end', end); request.on('error', aborted); request.on('aborted', aborted);
  });
}

export function createServer({ env = process.env, send,
  serviceOptions = {}, maxBytes = 8192, bodyTimeoutMs = 5000, serveStatic } = {}) {
  const configuredSender = Boolean(bitrixConfig(env));
  // Real CRM delivery always requires a persistent local journal. Mock preview may be memory-only.
  const persistent = Boolean(env.LEADS_DB_PATH);
  const store = persistent ? openLeadStore(env.LEADS_DB_PATH) : null;
  const options = { ...serviceOptions, send: send ?? createBitrixSender({ env }) };
  const service = persistent
    ? createPersistentLeadService({ ...options, store, reconcile: serviceOptions.reconcile ?? createBitrixReconciler({ env }) })
    : createLeadService(options);
  const appOrigin = parseOrigin(env.APP_ORIGIN);
  const configured = (typeof send === 'function' || (configuredSender && persistent && env.LEADS_DB_PATH !== ':memory:')) && (!env.APP_ORIGIN || Boolean(appOrigin)) &&
    (env.NODE_ENV !== 'production' || appOrigin?.startsWith('https://'));
  let draining = false;
  let activeHandlers = 0;
  let listenerClosed = false;
  let shutdownPromise;
  let finishShutdown;
  const finishIfDrained = () => {
    if (listenerClosed && activeHandlers === 0) finishShutdown?.(true);
  };
  const server = http.createServer(async (request, response) => {
    // A client socket can close while the CRM call is still running. Track the actual
    // handler lifetime, not response/socket events, before allowing process exit.
    activeHandlers++;
    try {
      const pathname = new URL(request.url, 'http://localhost').pathname;
      if (pathname === '/healthz' && request.method === 'GET') return reply(response, { status: 200, body: { ok: true } });
      if (pathname === '/readyz' && request.method === 'GET') return reply(response,
        configured && !draining ? { status: 200, body: { ok: true } } : failure(503, 'NOT_READY'));
      if (pathname !== '/api/leads') {
        if (serveStatic) return await serveStatic(request, response);
        return reply(response, failure(404, 'NOT_FOUND'));
      }
      if (request.method !== 'POST') { response.setHeader('Allow', 'POST'); return reply(response, failure(405, 'METHOD_NOT_ALLOWED')); }
      if (draining || !configured) {
        response.setHeader('Connection', 'close');
        return reply(response, failure(503, 'DELIVERY_UNAVAILABLE'));
      }
      const remote = request.socket.remoteAddress || '';
      // Only opt in behind a loopback reverse proxy which overwrites X-Real-IP.
      const forwarded = request.headers['x-real-ip'];
      const trusted = env.TRUST_LOOPBACK_PROXY === '1' && ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote);
      const ip = trusted && typeof forwarded === 'string' && isIP(forwarded) ? forwarded : remote;
      if (!service.admit(ip)) return reply(response, failure(429, 'RATE_LIMITED'));
      const origin = request.headers.origin;
      const expected = appOrigin || `http://${request.headers.host}`;
      if (request.headers['sec-fetch-site'] === 'cross-site' || (origin && origin !== expected)) return reply(response, failure(403, 'ORIGIN_NOT_ALLOWED'));
      if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers['content-type'] || '') || request.headers['content-encoding']) {
        return reply(response, failure(400, 'INVALID_CONTENT_TYPE'));
      }
      if (Number(request.headers['content-length']) > maxBytes) {
        response.setHeader('Connection', 'close');
        return reply(response, failure(413, 'BODY_TOO_LARGE'));
      }
      let body;
      try { body = await readBody(request, maxBytes, bodyTimeoutMs); }
      catch (error) { response.setHeader('Connection', 'close'); return reply(response, error); }
      const result = await service.submit(body, request.headers['idempotency-key']);
      if (draining) response.setHeader('Connection', 'close');
      return reply(response, result);
    } catch {
      // Deliberately omit exception details: fetch errors may include a webhook secret.
      reply(response, failure(503, 'DELIVERY_UNAVAILABLE'));
    } finally {
      activeHandlers--;
      finishIfDrained();
      if (listenerClosed && activeHandlers === 0) closeStore();
    }
  });
  // Close the journal only after all handlers, including disconnected clients, finish.
  let storeClosed = false;
  const closeStore = () => { if (store && !storeClosed) { storeClosed = true; store.close(); } };
  server.on('close', () => { if (activeHandlers === 0) closeStore(); });
  server.headersTimeout = 10_000;
  server.requestTimeout = 15_000;
  server.maxRequestsPerSocket = 100;
  server.beginDrain = () => { draining = true; };
  server.shutdown = ({ timeoutMs = 20_000 } = {}) => {
    if (shutdownPromise) return shutdownPromise;
    server.beginDrain();
    shutdownPromise = new Promise(resolve => {
      let settled = false;
      const timer = setTimeout(() => {
        server.closeAllConnections();
        finishShutdown(false);
      }, timeoutMs);
      finishShutdown = drained => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(drained);
      };
      server.close(() => {
        listenerClosed = true;
        finishIfDrained();
      });
    });
    return shutdownPromise;
  };
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.env.NODE_ENV === 'production' && (!bitrixConfig(process.env) || !process.env.LEADS_DB_PATH || process.env.LEADS_DB_PATH === ':memory:' || !parseOrigin(process.env.APP_ORIGIN)?.startsWith('https://'))) {
    console.error('Missing production configuration. See backend/README.md.');
    process.exitCode = 1;
  } else {
    const server = createServer({ serviceOptions: { onDelivery: event => console.log(JSON.stringify(event)) } });
    const port = Number(process.env.PORT || 4322);
    const host = process.env.HOST || '127.0.0.1';
    server.listen(port, host, () => console.log(`DAO API listening on ${host}:${port}`));
    server.on('error', () => { console.error('API could not start. Check host/port configuration.'); process.exitCode = 1; });
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
      server.shutdown().then(drained => process.exit(drained ? 0 : 1));
    });
  }
}
