import { upgradeWebSocket } from '@vercel/functions';
import { WebSocket } from 'ws';
import { sharedCache } from '../lib/cache.js';
import { SAID } from '../lib/handlers.js';
import { gradiumSocket, liveRequest, relay } from '../lib/live.js';

/** GET /api/live?lang=en, upgraded to a socket: one live press (lib/live.js). */
export function GET(request) {
  const asked = liveRequest(request);
  if (asked.refuse) return Response.json({ error: asked.refuse, message: SAID[asked.refuse] }, { status: asked.status, headers: { 'cache-control': 'no-store' } });
  if ((request.headers.get('upgrade') ?? '').toLowerCase() !== 'websocket') return Response.json({ error: 'method', message: 'This address is a WebSocket.' }, { status: 426, headers: { 'cache-control': 'no-store', upgrade: 'websocket' } });
  return upgradeWebSocket((socket) => relay(socket, { language: asked.language, address: asked.address, cache: sharedCache(), connect: gradiumSocket(WebSocket) }), { maxPayload: 64 * 1024 });
}
