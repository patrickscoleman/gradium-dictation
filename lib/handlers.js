import { CONFIG, LANGUAGES, MAX_BYTES } from './config.js';
import { aboveFloor, transcribe } from './gradium.js';
import { createLimits } from './limits.js';
import { clipSeconds } from './wav.js';

const PRIVATE = { 'cache-control': 'no-store', 'x-robots-tag': 'noindex, nofollow' };
const json = (status, body, extra = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...PRIVATE, ...extra } });

/** What a refusal says to the visitor. The page shows these as they are. */
export const SAID = Object.freeze({
  method: 'Send a clip with POST.',
  elsewhere: 'This demo only answers its own page.',
  not_wav: 'Send a 16 kHz, 16-bit, mono WAV clip.',
  too_long: `A clip can be ${CONFIG.clipSeconds} seconds at most.`,
  too_short: 'That was too short to hear. Hold a little longer.',
  language: 'Choose English, French, German, Spanish, Portuguese or automatic.',
  bad_key: 'That does not look like a Gradium key.',
  no_key: 'The shared demo key is not set up yet. Paste your own Gradium key to try it.',
  slow_down: 'That is a lot of clips. Try again in a few minutes.',
  visitor_limit: 'You have used your share of today’s demo. Paste your own Gradium key to keep going.',
  paused_today: 'Demo paused for today. Paste your own Gradium key to keep going, or come back tomorrow.',
  key_refused: 'Gradium did not accept that key.',
  out_of_credits: 'That key has no credits left.',
  vendor: 'Gradium could not transcribe that. Try again.',
});
const refuse = (status, reason, extra) => json(status, { error: reason, message: SAID[reason] }, extra);

/** The address Vercel saw the request come from. A header a visitor sets is overwritten there. */
const addressOf = (request) => request.headers.get('x-real-ip') ?? request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? '';

/** A page on another site cannot use the demo from a visitor's browser. Scripts can lie; the limits are for them. */
function fromOwnPage(request) {
  const site = request.headers.get('sec-fetch-site');
  if (site && site !== 'same-origin') return false;
  const origin = request.headers.get('origin');
  if (!origin) return true;
  try {
    return new URL(origin).host === (request.headers.get('x-forwarded-host') ?? request.headers.get('host') ?? new URL(request.url).host);
  } catch {
    return false;
  }
}

/**
 * POST /api/transcribe?lang=en with a WAV body: the clip's text, as plain
 * text that arrives while Gradium is still listening.
 *
 * Every check that costs nothing comes first; the limits come last, just
 * before the call that spends. `x-gradium-key` is a visitor's own key: it
 * is passed to Gradium for this one request and kept nowhere.
 */
export async function handleTranscribe(request, { cache, sharedKey = process.env.GRADIUM_API_KEY, now, send = transcribe, floor = aboveFloor } = {}) {
  if (request.method !== 'POST') return refuse(405, 'method', { allow: 'POST' });
  if (!fromOwnPage(request)) return refuse(403, 'elsewhere');
  const language = new URL(request.url).searchParams.get('lang') ?? 'en';
  if (!LANGUAGES.includes(language)) return refuse(400, 'language');
  if (!(request.headers.get('content-type') ?? '').startsWith('audio/wav')) return refuse(415, 'not_wav');
  if (Number(request.headers.get('content-length') ?? 0) > MAX_BYTES) return refuse(413, 'too_long');

  const ownKey = request.headers.get('x-gradium-key')?.trim() ?? '';
  if (ownKey && !/^[A-Za-z0-9_.\-]{16,200}$/.test(ownKey)) return refuse(400, 'bad_key');
  const key = ownKey || sharedKey?.trim();
  if (!key) return refuse(503, 'no_key');

  const wav = new Uint8Array(await request.arrayBuffer());
  if (wav.byteLength > MAX_BYTES) return refuse(413, 'too_long');
  const seconds = clipSeconds(wav);
  if (seconds === null) return refuse(415, 'not_wav');
  if (seconds < CONFIG.minSeconds) return refuse(422, 'too_short');
  if (seconds > CONFIG.clipSeconds + 0.5) return refuse(413, 'too_long');

  const own = Boolean(ownKey);
  if (!own && !(await floor(key, cache))) return refuse(429, 'paused_today');
  const admitted = await createLimits(cache, now).admit({ address: addressOf(request), seconds, own });
  if (!admitted.ok) return refuse(429, admitted.reason, admitted.retryAfter ? { 'retry-after': String(admitted.retryAfter) } : {});

  try {
    const words = await send({ key, wav, language, signal: AbortSignal.timeout(25_000) });
    return new Response(words, { headers: { 'content-type': 'text/plain; charset=utf-8', 'x-clip-seconds': seconds.toFixed(2), 'x-key': own ? 'own' : 'shared', ...PRIVATE } });
  } catch (error) {
    // The status and nothing else: never the key, never what the visitor said.
    console.error(`transcribe failed (${own ? 'own' : 'shared'} key): ${error?.message ?? 'unknown'}`);
    if (error?.keyRefused) return refuse(own ? 401 : 503, own ? 'key_refused' : 'no_key');
    if (error?.outOfCredits) return refuse(own ? 402 : 429, own ? 'out_of_credits' : 'paused_today');
    return refuse(502, 'vendor');
  }
}

/** GET /api/status: whether the shared key is there, and how much of today is left. */
export async function handleStatus(request, { cache, sharedKey = process.env.GRADIUM_API_KEY, now } = {}) {
  if (request.method !== 'GET') return refuse(405, 'method', { allow: 'GET' });
  const shared = Boolean(sharedKey?.trim());
  const remaining = shared ? await createLimits(cache, now).remainingToday() : 0;
  return json(200, { shared, remainingSeconds: remaining, dailySeconds: CONFIG.dailySeconds, clipSeconds: CONFIG.clipSeconds });
}
