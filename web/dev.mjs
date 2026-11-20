// The demo on this machine, without Vercel: the page from public/, the two
// functions from lib/, the headers from vercel.json, and a Map for the
// counts. `GRADIUM_API_KEY=... node dev.mjs`, or leave the key out and paste
// one into the page.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleStatus, handleTranscribe } from './lib/handlers.js';
import { memoryCache } from './lib/limits.js';

const here = fileURLToPath(new URL('.', import.meta.url));
const headers = JSON.parse(await readFile(join(here, 'vercel.json'), 'utf8')).headers[0].headers;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8' };
const cache = memoryCache();
const port = Number(process.env.PORT ?? 4173);

createServer(async (req, res) => {
  for (const { key, value } of headers) res.setHeader(key, value);
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname.startsWith('/api/')) {
    const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : Buffer.concat(await req.toArray());
    const request = new Request(url, { method: req.method, headers: req.headers, body });
    const response = await (url.pathname === '/api/transcribe' ? handleTranscribe(request, { cache }) : handleStatus(request, { cache }));
    res.writeHead(response.status, Object.fromEntries(response.headers));
    if (response.body) for await (const chunk of response.body) res.write(chunk);
    return res.end();
  }
  const file = join(here, 'public', normalize(url.pathname === '/' ? '/index.html' : url.pathname));
  if (!file.startsWith(join(here, 'public'))) return res.writeHead(404).end();
  try {
    const bytes = await readFile(file);
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' }).end(bytes);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
  }
}).listen(port, '127.0.0.1', () => console.log(`gradium-dictation demo on http://127.0.0.1:${port}`));
