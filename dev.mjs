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
import { GRADIUM, gradiumSocket, liveRequest, relay } from './lib/live.js';
import { WebSocket, WebSocketServer } from 'ws';

const here = fileURLToPath(new URL('.', import.meta.url));
const headers = JSON.parse(await readFile(join(here, 'vercel.json'), 'utf8')).headers[0].headers;
// To try the page framed by another local page (the deck's slide does this in production from app.alloglot.com):
// DEV_FRAMED_BY=http://127.0.0.1:4400 node dev.mjs
if (process.env.DEV_FRAMED_BY) for (const header of headers) if (header.key === 'Content-Security-Policy') header.value = header.value.replace("frame-ancestors 'self'", `frame-ancestors 'self' ${process.env.DEV_FRAMED_BY}`);
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8' };
const cache = memoryCache();
const port = Number(process.env.PORT ?? 4173);

const server = createServer(async (req, res) => {
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
});

// Behind a proxy (an agent's sandbox, say) `ws` cannot reach Gradium, and Node's own WebSocket can:
// the same socket, given the three calls the relay uses.
const proxied = (key) => {
  const socket = new globalThis.WebSocket(GRADIUM, { headers: { 'x-api-key': key } });
  return { get readyState() { return socket.readyState; }, send: (data) => socket.send(data), close: () => socket.close(), on: (type, heard) => socket.addEventListener(type, (event) => heard(type === 'message' ? event.data : event)) };
};
const connect = process.env.HTTPS_PROXY || process.env.https_proxy ? proxied : gradiumSocket(WebSocket);

// The live relay, as /api/live does it on Vercel.
const sockets = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
server.on('upgrade', (req, socket, head) => {
  const asked = liveRequest(new Request(new URL(req.url, `http://${req.headers.host}`), { headers: req.headers }));
  if (!req.url.startsWith('/api/live') || asked.refuse) return socket.destroy();
  sockets.handleUpgrade(req, socket, head, (ws) => relay(ws, { language: asked.language, address: asked.address, cache, connect }));
});

server.listen(port, '127.0.0.1', () => console.log(`gradium-dictation demo on http://127.0.0.1:${port}`));
