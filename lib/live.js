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
 * What the browser sends: optionally `{ "type": "warm", "lang"?, "key"? }`
 * when a press looks likely, so Gradium's socket is open and set up before
 * it; then `{ "type": "start", "lang"?: "fr", "key"?: "..." }`, then
 * binary frames of 16 kHz, 16-bit, mono PCM, `{ "type": "pause" }` whenever
 * the visitor stops for breath, then `{ "type": "flush" }` when they let go. What it gets back: `ready`, then Gradium's own
 * `text`, `end_text` and `flushed` lines as they are, then `done`; or
 * `refused` with a reason the page can show.
 *
 * `client` and what `connect` returns are `ws` sockets (or anything with
 * `on`, `send`, `close` and `readyState`), so a test can stand in for both.
 */
/** Gradium sockets opened ahead of a press, in this instance: a few, since each holds one of the account's sessions. */
let ahead = 0;

export function relay(client, { language, address, cache, sharedKey = process.env.GRADIUM_API_KEY, now, connect, floor = aboveFloor, clock = () => performance.now() }) {
  const limits = createLimits(cache, now);
  const opened = clock();
  let upstream = null;
  let line = null;
  let counted = false;
  let started = false;
  let admitted = false;
  let ready = false;
  let finishing = false;
  let over = false;
  let own = false;
  let sent = 0;
  let held = 0;
  let waiting = [];
  let quiet = null;
  let blocked = null;
  let caughtUpAt = 0;
  let catchUps = 0;
  const took = {};
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
    if (counted) ahead--;
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

  /**
   * The visitor paused mid-press: ask Gradium for the words it is still
   * holding back, and keep the press open. Its delay (`delayInFrames`) is how
   * long it waits to be sure of a word; in a pause there is nothing more to
   * wait for. The last flush of a press is number 1; these count from 2.
   */
  function catchUp() {
    if (!ready || !admitted || finishing || over || upstream?.readyState !== OPEN) return;
    if (catchUps >= CONFIG.catchUps || clock() - caughtUpAt < CONFIG.catchUpGapMs) return;
    caughtUpAt = clock();
    catchUps++;
    upstream.send(JSON.stringify({ type: 'flush', flush_id: 1 + catchUps }));
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

  /** Which key a message asks for, or the reason it cannot have one. */
  function keyFor(message) {
    const ownKey = typeof message.key === 'string' ? message.key.trim() : '';
    if (ownKey && !/^[A-Za-z0-9_.\-]{16,200}$/.test(ownKey)) return { refuse: 'bad_key' };
    const key = ownKey || sharedKey?.trim();
    return key ? { key, own: Boolean(ownKey) } : { refuse: 'no_key' };
  }

  /** Audio goes on only when the press is let in and Gradium is listening. */
  function go() {
    if (!admitted || !ready || over) return;
    say({ type: 'ready', delay_in_frames: CONFIG.delayInFrames, key: own ? 'own' : 'shared', took });
    for (const pcm of waiting.splice(0)) forward(pcm);
  }

  /** Open Gradium's socket for `key` and `lang` and set it up. No audio is sent on it, so nothing is spent, until the press is let in. */
  function dial(key, lang) {
    const dialled = clock();
    line = `${key}|${lang}`;
    const socket = connect(key);
    upstream = socket;
    // A socket that was put aside for another key or language has nothing more to say here.
    const mine = () => socket === upstream;
    socket.on('open', () => {
      if (!mine()) return;
      took.connect = Math.round(clock() - dialled);
      upstream.send(JSON.stringify({ type: 'setup', model_name: 'default', input_format: `pcm_${CONFIG.sampleRate}`, json_config: { language: lang, delay_in_frames: CONFIG.delayInFrames } }));
    });
    socket.on('message', (data) => {
      if (!mine()) return;
      let heard;
      try {
        heard = JSON.parse(String(data));
      } catch {
        return;
      }
      if (heard.type === 'ready') {
        ready = true;
        took.setup = Math.round(clock() - dialled) - (took.connect ?? 0);
        if (!started) say({ type: 'warm', took });
        go();
      } else if (heard.type === 'text') {
        say({ type: 'text', text: heard.text, start_s: heard.start_s });
      } else if (heard.type === 'end_text') {
        say({ type: 'end_text', stop_s: heard.stop_s });
      } else if (heard.type === 'flushed') {
        // Only the flush that ends a press settles it: one sent in a pause is just words arriving sooner.
        say({ type: 'flushed', final: heard.flush_id === 1 });
      } else if (heard.type === 'end_of_stream') {
        end(1000, finishing ? 'released' : 'ended');
      } else if (heard.type === 'error') {
        // Gradium's own words stay here: they can name the key.
        console.error(`live: Gradium refused (${own ? 'own' : 'shared'} key), code ${heard.code ?? 'none'}`);
        const why = /key|token|unauthori[sz]ed|expired/i.test(String(heard.message)) ? (own ? 'key_refused' : 'no_key') : /credit|quota/i.test(String(heard.message)) ? (own ? 'out_of_credits' : 'paused_today') : 'vendor';
        started ? refuse(why) : (blocked = why);
      }
    });
    socket.on('error', () => {
      if (!mine()) return;
      console.error(`live: could not reach Gradium (${own ? 'own' : 'shared'} key)`);
      if (!ready) started ? refuse(own ? 'key_refused' : 'vendor') : (blocked = own ? 'key_refused' : 'vendor');
    });
    socket.on('close', () => {
      if (!mine()) return;
      if (started) return end(1000, finishing ? 'released' : 'ended');
      upstream = null;
      line = null;
      ready = false;
    });
  }

  /**
   * The page says a press looks likely: check the floor and have Gradium's
   * socket open and set up before it comes. Nothing is counted against
   * anybody yet, and an idle socket costs nothing (measured 2026-11-20: 70
   * idle seconds, 3 credits).
   */
  async function warm(message) {
    if (started || upstream || over) return;
    if (LANGUAGES.includes(message.lang)) language = message.lang;
    const chosen = keyFor(message);
    if (chosen.refuse) return;
    own = chosen.own;
    try {
      if (!own && !(await floor(chosen.key, cache))) return void (blocked = 'paused_today');
    } catch {
      return;
    }
    if (started || upstream || over || ahead >= CONFIG.socketsAhead) return;
    ahead++;
    counted = true;
    dial(chosen.key, language);
  }

  async function start(message) {
    started = true;
    clearTimeout(hello);
    const began = clock();
    if (LANGUAGES.includes(message.lang)) language = message.lang;
    const chosen = keyFor(message);
    if (chosen.refuse) return refuse(chosen.refuse);
    // A socket opened ahead for another key or language is not this press's.
    if (upstream && line !== `${chosen.key}|${language}`) {
      const stale = upstream;
      upstream = null;
      ready = false;
      blocked = null;
      try {
        stale.close();
      } catch {
        /* already gone */
      }
    }
    own = chosen.own;
    if (blocked) return refuse(blocked);
    try {
      if (!own && !(await floor(chosen.key, cache))) return refuse('paused_today');
      // Gradium's socket opens while the press is being counted: an unused one costs nothing.
      if (!upstream && !over) dial(chosen.key, language);
      const admittedNow = await limits.admit({ address, seconds: CONFIG.clipSeconds, own });
      if (!admittedNow.ok) return refuse(admittedNow.reason);
    } catch {
      return refuse('vendor');
    }
    if (over) return;
    if (!own) held = CONFIG.clipSeconds;
    took.admit = Math.round(clock() - began);
    took.warm = Math.round(began - opened);
    admitted = true;
    go();
  }

  client.on('message', (data, isBinary) => {
    if (over) return;
    if (isBinary) {
      if (!started || finishing) return;
      const pcm = Buffer.isBuffer(data) ? data : Buffer.concat([data].flat());
      if (ready && admitted) return forward(pcm);
      // Said before the press was let in or Gradium was ready: kept, in order, up to a clip's worth.
      if (waiting.reduce((n, part) => n + part.length, 0) + pcm.length <= CONFIG.clipSeconds * BYTES_A_SECOND) waiting.push(pcm);
      return;
    }
    let message;
    try {
      message = JSON.parse(String(data));
    } catch {
      return;
    }
    if (message?.type === 'warm' && !started) warm(message);
    else if (message?.type === 'start' && !started) start(message);
    else if (message?.type === 'pause' && started) catchUp();
    else if (message?.type === 'flush' && started) ready && admitted ? finish('released') : end(1000, 'released');
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
