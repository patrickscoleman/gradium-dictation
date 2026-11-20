import { CONFIG, LANGUAGES } from './config.js';
import { aboveFloor } from './gradium.js';
import { SAID } from './handlers.js';
import { createLimits } from './limits.js';

export const GRADIUM = 'wss://api.gradium.ai/api/speech/asr';
const BYTES_A_SECOND = CONFIG.sampleRate * 2;
const OPEN = 1;

/**
 * One live press, relayed: the visitor's browser on one side, Gradium's
 * streaming speech-to-text on the other, and this function in between
 * holding the key.
 *
 * Why a relay and not a token for the browser: measured on 2026-11-20, one
 * of Gradium's short-lived tokens opens a socket nothing then cuts (100 s
 * and counting; the docs allow 3,000), billed at 3 credits for every second
 * of audio sent. A limit on tokens is therefore not a limit on spend. Here
 * the server counts the audio itself, ends the press at `clipSeconds`, and
 * charges the same day's allowance the clip route does.
 *
 * What the browser sends: `{ "type": "start", "lang"?: "fr", "key"?: "..." }` first, then
 * binary frames of 16 kHz, 16-bit, mono PCM, then `{ "type": "flush" }`
 * when the visitor lets go. What it gets back: `ready`, then Gradium's own
 * `text`, `end_text` and `flushed` lines as they are, then `done`; or
 * `refused` with a reason the page can show.
 *
 * `client` and what `connect` returns are `ws` sockets (or anything with
 * `on`, `send`, `close` and `readyState`), so a test can stand in for both.
 */
export function relay(client, { language, address, cache, sharedKey = process.env.GRADIUM_API_KEY, now, connect, floor = aboveFloor }) {
  const limits = createLimits(cache, now);
  let upstream = null;
  let started = false;
  let ready = false;
  let finishing = false;
  let over = false;
  let own = false;
  let sent = 0;
  let held = 0;
  let waiting = [];
  let quiet = null;
  const say = (message) => client.readyState === OPEN && client.send(JSON.stringify(message));
  const wall = setTimeout(() => end(1000, 'time'), CONFIG.wallSeconds * 1000);
  // The page opens the socket when a press looks likely, so the press itself starts at once: an unused one just closes.
  const hello = setTimeout(() => !started && end(1000, 'idle'), CONFIG.helloSeconds * 1000);

  /** Close both sides, once, and give back the part of the allowance the press did not use. */
  function end(code = 1000, why = 'done') {
    if (over) return;
    over = true;
    clearTimeout(wall);
    clearTimeout(hello);
    clearTimeout(quiet);
    const seconds = sent / BYTES_A_SECOND;
    if (held) limits.giveBack({ address, seconds: held - Math.ceil(seconds) }).catch(() => {});
    say({ type: 'done', seconds: Number(seconds.toFixed(2)), why });
    try {
      upstream?.close();
    } catch {
      /* already gone */
    }
    try {
      client.close(code);
    } catch {
      /* already gone */
    }
  }

  function refuse(reason) {
    say({ type: 'refused', error: reason, message: SAID[reason] ?? SAID.vendor });
    end(1008, reason);
  }

  /** The visitor let go, or the clip is as long as a clip may be: ask Gradium for the last words, then for the end. */
  function finish(why) {
    if (finishing || over) return;
    finishing = true;
    clearTimeout(quiet);
    if (!upstream || upstream.readyState !== OPEN) return end(1000, why);
    upstream.send(JSON.stringify({ type: 'flush', flush_id: 1 }));
    upstream.send(JSON.stringify({ type: 'end_of_stream' }));
    setTimeout(() => end(1000, why), 4_000);
  }

  function forward(pcm) {
    if (finishing || over) return;
    const room = CONFIG.clipSeconds * BYTES_A_SECOND - sent;
    const part = pcm.length > room ? pcm.subarray(0, room - (room % 2)) : pcm;
    if (part.length) {
      sent += part.length;
      upstream.send(JSON.stringify({ type: 'audio', audio: Buffer.from(part).toString('base64') }));
    }
    clearTimeout(quiet);
    quiet = setTimeout(() => finish('quiet'), CONFIG.quietSeconds * 1000);
    if (sent >= CONFIG.clipSeconds * BYTES_A_SECOND) {
      say({ type: 'limit' });
      finish('limit');
    }
  }

  async function start(message) {
    started = true;
    clearTimeout(hello);
    if (LANGUAGES.includes(message.lang)) language = message.lang;
    const ownKey = typeof message.key === 'string' ? message.key.trim() : '';
    if (ownKey && !/^[A-Za-z0-9_.\-]{16,200}$/.test(ownKey)) return refuse('bad_key');
    own = Boolean(ownKey);
    const key = ownKey || sharedKey?.trim();
    if (!key) return refuse('no_key');
    try {
      if (!own && !(await floor(key, cache))) return refuse('paused_today');
      const admitted = await limits.admit({ address, seconds: CONFIG.clipSeconds, own });
      if (!admitted.ok) return refuse(admitted.reason);
    } catch {
      return refuse('vendor');
    }
    if (over) return;
    if (!own) held = CONFIG.clipSeconds;

    upstream = connect(key);
    upstream.on('open', () => {
      upstream.send(JSON.stringify({ type: 'setup', model_name: 'default', input_format: `pcm_${CONFIG.sampleRate}`, json_config: { language, delay_in_frames: CONFIG.delayInFrames } }));
    });
    upstream.on('message', (data) => {
      let line;
      try {
        line = JSON.parse(String(data));
      } catch {
        return;
      }
      if (line.type === 'ready') {
        ready = true;
        say({ type: 'ready', delay_in_frames: line.delay_in_frames ?? CONFIG.delayInFrames, key: own ? 'own' : 'shared' });
        for (const pcm of waiting.splice(0)) forward(pcm);
      } else if (line.type === 'text') {
        say({ type: 'text', text: line.text, start_s: line.start_s });
      } else if (line.type === 'end_text') {
        say({ type: 'end_text', stop_s: line.stop_s });
      } else if (line.type === 'flushed') {
        say({ type: 'flushed' });
      } else if (line.type === 'end_of_stream') {
        end(1000, finishing ? 'released' : 'ended');
      } else if (line.type === 'error') {
        // Gradium's own words stay here: they can name the key.
        console.error(`live: Gradium refused (${own ? 'own' : 'shared'} key), code ${line.code ?? 'none'}`);
        refuse(/key|token|unauthori[sz]ed|expired/i.test(String(line.message)) ? (own ? 'key_refused' : 'no_key') : /credit|quota/i.test(String(line.message)) ? (own ? 'out_of_credits' : 'paused_today') : 'vendor');
      }
    });
    upstream.on('error', () => {
      console.error(`live: could not reach Gradium (${own ? 'own' : 'shared'} key)`);
      if (!ready) refuse(own ? 'key_refused' : 'vendor');
    });
    upstream.on('close', () => end(1000, finishing ? 'released' : 'ended'));
  }

  client.on('message', (data, isBinary) => {
    if (over) return;
    if (isBinary) {
      if (!started || finishing) return;
      const pcm = Buffer.isBuffer(data) ? data : Buffer.concat([data].flat());
      if (ready) return forward(pcm);
      // Said before Gradium was ready: kept, in order, up to a clip's worth.
      if (waiting.reduce((n, part) => n + part.length, 0) + pcm.length <= CONFIG.clipSeconds * BYTES_A_SECOND) waiting.push(pcm);
      return;
    }
    let message;
    try {
      message = JSON.parse(String(data));
    } catch {
      return;
    }
    if (message?.type === 'start' && !started) start(message);
    else if (message?.type === 'flush' && started) ready ? finish('released') : end(1000, 'released');
  });
  client.on('close', () => end(1000, 'left'));
  client.on('error', () => end(1011, 'left'));
}

/** What the upgrade must have before a socket is opened at all. Returns a reason to refuse, or the language. */
export function liveRequest(request) {
  const origin = request.headers.get('origin');
  const host = request.headers.get('x-forwarded-host') ?? request.headers.get('host') ?? new URL(request.url).host;
  try {
    // A socket carries no same-origin rule of its own, so this is it: only the demo's own page.
    if (!origin || new URL(origin).host !== host) return { refuse: 'elsewhere', status: 403 };
  } catch {
    return { refuse: 'elsewhere', status: 403 };
  }
  const language = new URL(request.url).searchParams.get('lang') ?? 'en';
  if (!LANGUAGES.includes(language)) return { refuse: 'language', status: 400 };
  return { language, address: request.headers.get('x-real-ip') ?? request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? '' };
}

export const gradiumSocket = (WebSocket) => (key) => new WebSocket(GRADIUM, { headers: { 'x-api-key': key } });
