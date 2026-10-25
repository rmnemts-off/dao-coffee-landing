// Local preview ONLY. Credentials are ignored and no requests reach Telegram.
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from './server.mjs';

if (process.env.NODE_ENV === 'production') throw new Error('Mock preview must not run in production');
const mode = process.env.MOCK_TELEGRAM_RESULT || 'delivered';
if (!['delivered', 'rejected', 'uncertain', 'unconfigured'].includes(mode)) throw new Error('Invalid mock mode');
const root = await realpath(fileURLToPath(new URL('../site/', import.meta.url)));
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.png': 'image/png', '.jpg': 'image/jpeg', '.woff2': 'font/woff2' };
const server = createServer({ env: {}, send: async () => { await delay(750); return { kind: mode }; },
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
const port = Number(process.env.PORT || 4322);
server.listen(port, '127.0.0.1', () => console.log(`MOCK ONLY (${mode}): http://127.0.0.1:${port}/ — no real Telegram delivery`));
