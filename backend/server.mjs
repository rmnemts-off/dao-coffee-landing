import http from 'node:http';
import { isIP } from 'node:net';
import { pathToFileURL } from 'node:url';
import { createLeadService, failure } from './leads.mjs';
import { createTelegramSender } from './telegram.mjs';

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

export function createServer({ env = process.env, send = createTelegramSender({ token: env.TELEGRAM_BOT_TOKEN, chatId: env.TELEGRAM_CHAT_ID }),
  serviceOptions = {}, maxBytes = 8192, bodyTimeoutMs = 5000, serveStatic } = {}) {
  const service = createLeadService({ ...serviceOptions, send });
  const appOrigin = env.APP_ORIGIN ? new URL(env.APP_ORIGIN).origin : null;
  const server = http.createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url, 'http://localhost').pathname;
      if (pathname === '/healthz' && request.method === 'GET') return reply(response, { status: 200, body: { ok: true } });
      if (pathname !== '/api/leads') {
        if (serveStatic) return await serveStatic(request, response);
        return reply(response, failure(404, 'NOT_FOUND'));
      }
      if (request.method !== 'POST') { response.setHeader('Allow', 'POST'); return reply(response, failure(405, 'METHOD_NOT_ALLOWED')); }
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
      return reply(response, await service.submit(body));
    } catch {
      // Deliberately omit exception details: fetch errors may include a bot token.
      reply(response, failure(503, 'DELIVERY_UNAVAILABLE'));
    }
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 15_000;
  server.maxRequestsPerSocket = 100;
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.env.NODE_ENV === 'production' && (!process.env.APP_ORIGIN || !process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_CHAT_ID)) {
    console.error('Missing production configuration. See backend/README.md.');
    process.exitCode = 1;
  } else {
    const server = createServer();
    const port = Number(process.env.PORT || 4322);
    const host = process.env.HOST || '127.0.0.1';
    server.listen(port, host, () => console.log(`DAO API listening on ${host}:${port}`));
    server.on('error', () => { console.error('API could not start. Check host/port configuration.'); process.exitCode = 1; });
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(1), 12_000).unref();
    });
  }
}
