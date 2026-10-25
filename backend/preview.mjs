// Local preview only. Default: mock; real delivery requires explicit --telegram.
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from './server.mjs';

if (process.env.NODE_ENV === 'production') throw new Error('Local preview must not run in production');
const live = process.argv.includes('--telegram');
if (live && (!process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_CHAT_ID)) {
  console.error('Real delivery requires TELEGRAM_BOT_TOKEN and an approved TELEGRAM_CHAT_ID in .env.');
  process.exit(1);
}
const port = Number(process.env.PORT || (live ? 4324 : 4322));
const origin = `http://127.0.0.1:${port}`;
const mode = process.env.MOCK_TELEGRAM_RESULT || 'delivered';
if (!['delivered', 'rejected', 'uncertain', 'unconfigured'].includes(mode)) throw new Error('Invalid mock mode');
const root = await realpath(fileURLToPath(new URL('../site/', import.meta.url)));
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.png': 'image/png', '.jpg': 'image/jpeg', '.woff2': 'font/woff2' };
const delivery = live ? { env: { ...process.env, APP_ORIGIN: origin, TRUST_LOOPBACK_PROXY: '' } }
  : { env: {}, send: async () => { await delay(750); return { kind: mode }; } };
const server = createServer({ ...delivery,
  serveStatic: async (request, response) => {
    if (!['GET', 'HEAD'].includes(request.method)) { response.writeHead(405, { Allow: 'GET, HEAD' }).end(); return; }
    try {
      const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
      if (pathname.split('/').some(part => part.startsWith('.'))) throw new Error();
      const candidate = await realpath(path.resolve(root, `.${pathname === '/' ? '/index.html' : pathname}`));
      if (path.relative(root, candidate).startsWith('..') || !(await stat(candidate)).isFile()) throw new Error();
      const body = await readFile(candidate);
      response.writeHead(200, { 'Content-Type': types[path.extname(candidate)] || 'application/octet-stream', 'Content-Length': body.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      response.end(request.method === 'HEAD' ? undefined : body);
    } catch { response.writeHead(404).end(); }
  },
});
server.listen(port, '127.0.0.1', () => console.log(live
  ? `REAL TELEGRAM DELIVERY: ${origin}/ — forms send to the configured recipient`
  : `MOCK ONLY (${mode}): ${origin}/ — no real Telegram delivery`));
