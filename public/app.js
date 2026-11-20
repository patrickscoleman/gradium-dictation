// gradium-dictation, the web demo: hold the button, speak, and watch the
// words arrive while you are still talking. Nothing is kept: no storage,
// no cookies.
import { cloud } from './cloud.js';
import { tidy, wordCount } from './tidy.js';

const CLIP_SECONDS = 30;
const RATE = 16_000;
const HOLD_MS = 400;
/** After a press the microphone stays open this long, so the next press starts at once. Nothing is sent between presses. */
const HOT_MS = 120_000;
/** A press begins with the moment before it, for a first word already on its way. */
const PREROLL_MS = 300;
/** A breath: this long without a voice, mid-press, and Gradium is asked for the words it is holding back. */
const PAUSE_MS = 260;
const COLUMNS = 14;
const DOTS = 5;
/** What an average typist manages: Dhakal et al., CHI 2018, 168,000 volunteers. */
const TYPING_WPM = 52;

const $ = (id) => document.getElementById(id);
const talk = $('talk');
const label = $('talk-label');
const clock = $('clock');
const meter = $('meter');
const text = $('text');
const status = $('status');
const lang = $('lang');
const keyField = $('key');
const tidyOn = $('tidy-on');
const dots = cloud($('cloud'));
const embedded = new URLSearchParams(location.search).has('embed');
document.documentElement.classList.toggle('embed', embedded);
const OWN_KEY_HINT = embedded ? 'Open it full screen and add your own Gradium key' : 'Add your own Gradium key below';

/** 'idle' | 'starting' | 'recording' | 'sending' */
let state = 'idle';
let context;
let stream;
let source;
let node;
let resample;
let pcm = [];
/** The last moment heard between presses, while the microphone is still open. */
let ring = [];
let cooling;
let startedAt = 0;
/** When the audio of this press begins: the press, less what was already heard. */
let audioFrom = 0;
let quietMs = 0;
let voiced = false;
let latched = false;
let releasedEarly = false;
let ticker;
let levels = new Array(COLUMNS).fill(0);
/** The press in flight: its socket, its line on the page, and its clock. */
let press = null;
let paused = false;

/* ---------- the meter: the mark's columns of dots, moving ---------- */

for (let c = 0; c < COLUMNS; c++) {
  const column = document.createElement('span');
  for (let d = 0; d < DOTS; d++) column.append(document.createElement('i'));
  meter.append(column);
}

function drawMeter() {
  [...meter.children].forEach((column, c) => {
    const lit = levels[c];
    [...column.children].forEach((dot, d) => {
      // Lit from the middle out, so a column grows both ways.
      const fromMiddle = Math.abs(d - (DOTS - 1) / 2);
      dot.className = lit > 0 && fromMiddle <= (lit - 1) / 2 ? 'on' : d === (DOTS - 1) / 2 ? 'rest' : '';
    });
  });
}

function hear(batch) {
  let sum = 0;
  for (let i = 0; i < batch.length; i++) sum += batch[i] * batch[i];
  const loud = Math.sqrt(sum / batch.length);
  // About -50 dB to -12 dB, onto one to five dots.
  const level = Math.max(0, Math.min(DOTS, Math.round(((20 * Math.log10(loud + 1e-7) + 50) / 38) * DOTS)));
  levels = [...levels.slice(1), level];
  drawMeter();
  dots.hear(level / DOTS);
  // The moment the visitor's voice is first heard, for the first-word clock.
  if (press && !press.spokeAt && level >= 2) press.spokeAt = performance.now();
  return level;
}

/** A voice, then a breath: tell the relay, once for each pause, so the words before it land without waiting out Gradium's delay. */
function breath(level, batchMs) {
  if (level >= 2) {
    voiced = true;
    quietMs = 0;
  } else if (voiced && (quietMs += batchMs) >= PAUSE_MS) {
    voiced = false;
    if (press?.live && press.socket?.readyState === WebSocket.OPEN) {
      press.socket.send(JSON.stringify({ type: 'pause' }));
      press.pauses++;
    }
  }
}

/** Between presses: keep only the last moment, and let the microphone go when nobody has pressed for a while. */
function keep(samples) {
  ring.push(samples);
  let held = ring.reduce((n, part) => n + part.length, 0);
  while (ring.length > 1 && held - ring[0].length >= (PREROLL_MS / 1000) * RATE) held -= ring.shift().length;
}

function letGo() {
  clearTimeout(cooling);
  if (state !== 'idle') return void (cooling = setTimeout(letGo, 5000));
  source?.disconnect();
  source = null;
  stream?.getTracks().forEach((track) => track.stop());
  stream = null;
  ring = [];
  context?.suspend();
}
drawMeter();

/* ---------- saying things ---------- */

function say(message, warn = false) {
  status.textContent = message;
  status.classList.toggle('warn', warn);
}

function chip(id, value) {
  const el = $(id);
  el.querySelector('b').textContent = value;
  el.classList.toggle('set', value !== '—');
}

function show() {
  const on = state === 'recording';
  talk.setAttribute('aria-pressed', String(on));
  talk.disabled = state === 'sending' || (paused && !keyField.value.trim());
  document.documentElement.classList.toggle('listening', on);
  label.textContent = on ? (latched ? 'Tap to stop' : 'Listening') : state === 'sending' ? 'Finishing' : state === 'starting' ? 'Starting' : talk.disabled ? 'Paused for today' : 'Hold to talk';
  if (!on) clock.textContent = `0:${String(CLIP_SECONDS).padStart(2, '0')}`;
}

async function allowance() {
  paused = false;
  if (keyField.value.trim()) {
    show();
    return say('On your own Gradium key. The shared limit does not apply.');
  }
  try {
    const answer = await (await fetch('/api/status', { cache: 'no-store' })).json();
    if (!answer.shared) say(`The shared key is not set up yet. ${OWN_KEY_HINT} to try it.`, true);
    else if (answer.remainingSeconds < 1) {
      paused = true;
      say(`Paused for today: the shared minutes are used up. It opens again at midnight UTC. ${OWN_KEY_HINT} to keep going.`, true);
    } else {
      const minutes = Math.floor(answer.remainingSeconds / 60);
      say(`Shared demo: ${minutes >= 1 ? `${minutes} min` : `${Math.floor(answer.remainingSeconds)} s`} of today’s ${Math.round(answer.dailySeconds / 60)} left for everyone.`);
    }
  } catch {
    say('');
  }
  show();
}

/* ---------- the microphone ---------- */

function microphoneProblem(error) {
  if (!navigator.mediaDevices?.getUserMedia) return 'This browser cannot record here. Try a current Safari, Chrome or Firefox.';
  if (error?.name === 'NotAllowedError' || error?.name === 'SecurityError') return 'The microphone is blocked for this page. Allow it in the browser’s site settings, then press again.';
  if (error?.name === 'NotFoundError') return 'No microphone was found.';
  if (error?.name === 'AsleepError') return 'The browser would not start audio. Tap the button once more.';
  return 'The microphone could not be started. Press again to retry.';
}

/** The microphone's samples at 16 kHz, a batch at a time: each output sample is the mean of the input it covers. */
function downsampler(from) {
  const ratio = from / RATE;
  let carry = new Float32Array(0);
  let offset = 0;
  return (batch) => {
    const input = new Float32Array(carry.length + batch.length);
    input.set(carry);
    input.set(batch, carry.length);
    const count = Math.floor((input.length - offset) / ratio);
    const out = new Int16Array(count);
    for (let i = 0; i < count; i++) {
      const start = Math.floor(offset + i * ratio);
      const end = Math.max(start + 1, Math.floor(offset + (i + 1) * ratio));
      let sum = 0;
      for (let k = start; k < end; k++) sum += input[k];
      out[i] = Math.max(-1, Math.min(1, sum / (end - start))) * 0x7fff;
    }
    const used = offset + count * ratio;
    carry = input.slice(Math.floor(used));
    offset = used - Math.floor(used);
    return out;
  };
}

async function begin() {
  if (state !== 'idle' || talk.disabled) return;
  state = 'starting';
  releasedEarly = false;
  latched = false;
  show();
  // The browser may be asking for the microphone: say so, so "Starting" is never a silent wait.
  const asking = setTimeout(() => state === 'starting' && say('Waiting for the microphone. If the browser is asking, choose Allow.'), 700);
  try {
    // Made inside the press, before anything is awaited: Safari starts an
    // audio context only from a gesture.
    context ??= new AudioContext();
    const awake = context.resume();
    // No echo cancelling: nothing is played back here, and it is the slowest part of the browser's own processing.
    stream ??= await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: false, noiseSuppression: true, autoGainControl: true } });
    // A context that will not wake in three seconds is not going to: carry on and let the first samples say so.
    await Promise.race([awake, new Promise((done) => setTimeout(done, 3000))]);
    if (context.state !== 'running') throw Object.assign(new Error('asleep'), { name: 'AsleepError' });
    if (!node) {
      await context.audioWorklet.addModule('/recorder-worklet.js');
      node = new AudioWorkletNode(context, 'recorder');
      node.port.onmessage = (event) => {
        if (!resample || state === 'sending') return;
        const samples = resample(event.data);
        if (state !== 'recording') return keep(samples);
        breath(hear(event.data), (event.data.length / context.sampleRate) * 1000);
        pcm.push(samples);
        if (press?.socket?.readyState === WebSocket.OPEN && !press.failed) press.socket.send(samples.buffer);
      };
      // Through a silent gain to the output, so the graph is pulled and nothing is heard.
      const silent = context.createGain();
      silent.gain.value = 0;
      node.connect(silent).connect(context.destination);
    }
    resample ??= downsampler(context.sampleRate);
    if (!source) {
      source = context.createMediaStreamSource(stream);
      source.connect(node);
    }
  } catch (error) {
    clearTimeout(asking);
    state = 'idle';
    show();
    say(microphoneProblem(error), true);
    return;
  }
  clearTimeout(asking);
  clearTimeout(cooling);
  // What the open microphone heard just before the press goes first.
  pcm = ring;
  ring = [];
  quietMs = 0;
  voiced = false;
  startedAt = performance.now();
  audioFrom = startedAt - (pcm.reduce((n, part) => n + part.length, 0) / RATE) * 1000;
  state = 'recording';
  // A press let go while the browser was still asking for the microphone is a tap.
  latched = releasedEarly;
  $('hint')?.remove();
  chip('first', '—');
  chip('lag', '—');
  chip('last', '—');
  open();
  say(latched ? 'Listening. Tap again when you are done.' : 'Listening.');
  navigator.vibrate?.(8);
  show();
  ticker = setInterval(() => {
    const left = CLIP_SECONDS - (performance.now() - startedAt) / 1000;
    clock.textContent = `0:${String(Math.max(0, Math.ceil(left))).padStart(2, '0')}`;
    if (left <= 0) finish();
  }, 200);
}

/* ---------- a live press ---------- */

/** A socket to the live relay, or nothing where there cannot be one. */
function socket() {
  try {
    const made = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/live`);
    made.binaryType = 'arraybuffer';
    return made;
  } catch {
    return null;
  }
}

/**
 * The next press's socket, opened when a press looks likely and told which
 * language and key it is for, so the relay has Gradium connected and set up
 * before the press. An unused one closes by itself after 20 seconds; while
 * somebody is plainly here, another takes its place.
 */
let warm = null;
let warmFor = '';
let hereUntil = 0;
const STAY_WARM_MS = 10 * 60_000;
function warmUp() {
  hereUntil = performance.now() + STAY_WARM_MS;
  rewarm();
}
function rewarm() {
  const wanted = `${lang.value}|${keyField.value.trim()}`;
  if (warm && warm.readyState <= WebSocket.OPEN) {
    if (warmFor === wanted) return;
    warm.close();
  }
  if (state !== 'idle' || talk.disabled || document.hidden || performance.now() > hereUntil) return;
  const made = socket();
  if (!made) return;
  warm = made;
  warmFor = wanted;
  const own = keyField.value.trim();
  made.addEventListener('open', () => made === warm && made.send(JSON.stringify({ type: 'warm', lang: lang.value, ...(own ? { key: own } : {}) })));
  // It lapsed unused: keep one ready while the visitor is still here.
  made.addEventListener('close', () => made === warm && ((warm = null), setTimeout(rewarm, 250)));
}

/** Open the live socket for this press. Words are drawn as they arrive; if it cannot be had, the clip is sent whole on release instead. */
function open() {
  const line = document.createElement('p');
  line.className = 'live';
  text.append(line);
  const own = keyField.value.trim();
  const mine = { socket: null, line, words: [], lags: [], pauses: 0, preroll: Math.round(startedAt - audioFrom), live: false, failed: false, warmed: false, pressedAt: performance.now(), spokeAt: 0, firstAt: 0, readyAt: 0, releasedAt: 0, done: null, refused: null, took: null };
  press = mine;
  mine.finished = new Promise((resolve) => (mine.done = resolve));
  mine.socket = warm && warm.readyState <= WebSocket.OPEN && warmFor === `${lang.value}|${own}` ? warm : socket();
  mine.warmed = mine.socket === warm && warm.readyState === WebSocket.OPEN;
  if (warm && warm !== mine.socket) warm.close();
  warm = null;
  if (!mine.socket) {
    mine.failed = true;
    return;
  }
  const start = () => {
    mine.socket.send(JSON.stringify({ type: 'start', lang: lang.value, ...(own ? { key: own } : {}) }));
    // What was said while the socket was opening goes first.
    for (const samples of pcm) mine.socket.send(samples.buffer);
  };
  if (mine.socket.readyState === WebSocket.OPEN) start();
  else mine.socket.addEventListener('open', start);
  mine.socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.type === 'ready') {
      mine.live = true;
      mine.readyAt = performance.now();
      mine.took = message.took;
    } else if (message.type === 'warm') mine.took = message.took;
    else if (message.type === 'text') word(mine, message.text, message.start_s);
    else if (message.type === 'end_text') mine.line.querySelector('span.fresh')?.classList.remove('fresh');
    else if (message.type === 'flushed') {
      mine.line.querySelectorAll('span.fresh').forEach((span) => span.classList.remove('fresh'));
      // A flush in a pause only brings words in sooner: the press goes on.
      if (message.final === false) return;
      mine.flushedAt = performance.now();
      if (mine.releasedAt) chip('last', `${Math.max(0, Math.round(mine.flushedAt - mine.releasedAt))} ms`);
    } else if (message.type === 'limit') finish();
    else if (message.type === 'refused') {
      // Gradium's socket could not be had: keep recording and send the clip whole on release.
      if (message.error === 'vendor') return void (mine.failed = true);
      mine.refused = message;
      finish();
    }
    else if (message.type === 'done') {
      mine.seconds = message.seconds;
      mine.socket.close();
    }
  });
  const over = () => {
    if (!mine.live) mine.failed = true;
    mine.done();
  };
  mine.socket.addEventListener('close', over);
  mine.socket.addEventListener('error', over);
}

/** One more word from Gradium: drawn light, and settled when Gradium says it is final. */
function word(mine, heard, startS) {
  const landed = performance.now();
  if (!mine.firstAt) {
    mine.firstAt = landed;
    if (mine.spokeAt) chip('first', `${Math.max(0, Math.round(mine.firstAt - mine.spokeAt))} ms`);
  }
  // How far behind the voice this word landed: now, against when Gradium says it began in the audio.
  if (typeof startS === 'number') {
    mine.lags.push(landed - audioFrom - startS * 1000);
    const recent = mine.lags.slice(-5).sort((a, b) => a - b);
    chip('lag', `${Math.max(0, Math.round(recent[Math.floor(recent.length / 2)]))} ms`);
  }
  mine.words.push(heard);
  const span = document.createElement('span');
  span.className = 'fresh';
  span.textContent = `${mine.words.length > 1 ? ' ' : ''}${heard}`;
  mine.line.append(span);
  text.scrollTop = text.scrollHeight;
}

function wav(samples) {
  const bytes = new DataView(new ArrayBuffer(44 + samples.length * 2));
  const write = (at, tag) => [...tag].forEach((c, i) => bytes.setUint8(at + i, c.charCodeAt(0)));
  write(0, 'RIFF');
  bytes.setUint32(4, 36 + samples.length * 2, true);
  write(8, 'WAVE');
  write(12, 'fmt ');
  bytes.setUint32(16, 16, true);
  bytes.setUint16(20, 1, true);
  bytes.setUint16(22, 1, true);
  bytes.setUint32(24, RATE, true);
  bytes.setUint32(28, RATE * 2, true);
  bytes.setUint16(32, 2, true);
  bytes.setUint16(34, 16, true);
  write(36, 'data');
  bytes.setUint32(40, samples.length * 2, true);
  samples.forEach((sample, i) => bytes.setInt16(44 + i * 2, sample, true));
  return bytes.buffer;
}

async function finish() {
  if (state !== 'recording') return;
  clearInterval(ticker);
  const mine = press;
  // The last syllable is still on its way through the worklet.
  await new Promise((done) => setTimeout(done, 140));
  mine.releasedAt = performance.now();
  state = 'sending';
  show();
  navigator.vibrate?.(8);
  // The microphone stays open for the next press, and is let go if none comes.
  cooling = setTimeout(letGo, HOT_MS);
  levels = new Array(COLUMNS).fill(0);
  drawMeter();

  const samples = new Int16Array(pcm.reduce((n, part) => n + part.length, 0));
  let at = 0;
  for (const part of pcm) {
    samples.set(part, at);
    at += part.length;
  }
  const seconds = Math.min(CLIP_SECONDS, samples.length / RATE);

  if (!mine.failed && mine.socket?.readyState === WebSocket.OPEN) {
    mine.socket.send(JSON.stringify({ type: 'flush' }));
    await Promise.race([mine.finished, new Promise((done) => setTimeout(done, 8000))]);
    if (mine.socket.readyState === WebSocket.OPEN) mine.socket.close();
  }
  if (mine.refused) {
    mine.line.remove();
    say(mine.refused.message, true);
    if (mine.refused.error === 'paused_today') await allowance();
  } else if (mine.live) {
    settle(mine.line, mine.words.join(' '), seconds, mine.releasedAt);
  } else if (samples.length < RATE * 0.4) {
    mine.line.remove();
    say('That was too short to hear. Hold a little longer.', true);
  } else {
    // No live socket here: send the clip whole, as the first version of this page did.
    await send(mine.line, wav(samples.subarray(0, CLIP_SECONDS * RATE)), seconds, mine.releasedAt);
  }
  // What this press took, step by step, for whoever is measuring (and for the console).
  const since = (at) => (at ? Math.round(at - mine.pressedAt) : null);
  window.lastPress = { warmed: mine.warmed, preroll: mine.preroll, pauses: mine.pauses, relay: mine.took, ready: since(mine.readyAt), spoke: since(mine.spokeAt), firstWord: since(mine.firstAt), released: since(mine.releasedAt), flushed: since(mine.flushedAt), firstWordAfterVoice: mine.firstAt && mine.spokeAt ? Math.round(mine.firstAt - mine.spokeAt) : null, lastWordAfterRelease: mine.flushedAt ? Math.round(mine.flushedAt - mine.releasedAt) : null };
  console.table(window.lastPress);
  press = null;
  state = 'idle';
  show();
  // Whoever spoke once is likely to speak again.
  warmUp();
}

/* ---------- a clip sent whole, when there is no live socket ---------- */

async function send(line, clip, seconds, released) {
  say('Transcribing with Gradium…');
  const own = keyField.value.trim();
  try {
    const response = await fetch(`/api/transcribe?lang=${encodeURIComponent(lang.value)}`, {
      method: 'POST',
      headers: { 'content-type': 'audio/wav', ...(own ? { 'x-gradium-key': own } : {}) },
      body: clip,
    });
    if (!response.ok) {
      const refusal = await response.json().catch(() => null);
      line.remove();
      return say(refusal?.message ?? 'That did not work. Try again.', true);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let heard = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      heard += decoder.decode(value, { stream: true });
      line.textContent = heard;
      text.scrollTop = text.scrollHeight;
    }
    chip('last', `${Math.round(performance.now() - released)} ms`);
    settle(line, heard, seconds, released);
  } catch {
    line.remove();
    say('The demo could not be reached. Check the connection and try again.', true);
  }
}

/* ---------- once the words are in: tidy, and how fast that was ---------- */

function settle(line, heard, seconds) {
  const said = heard.trim();
  if (!said) {
    line.remove();
    return say('No words were heard. Try again, a little closer to the microphone.', true);
  }
  line.className = '';
  line.dataset.heard = said;
  line.dataset.language = lang.value;
  write(line);
  const words = wordCount(said);
  say(`${words} ${words === 1 ? 'word' : 'words'} in ${seconds.toFixed(1)} s of speech.`);
  pace(words, seconds);
  setTimeout(() => state === 'idle' && allowance(), 8000);
}

/** Draw a clip's line: tidied or as it was heard, with what the tidy-up took out. */
function write(line) {
  const heard = line.dataset.heard;
  const tidied = tidy(heard, line.dataset.language);
  const shown = tidyOn.checked && tidied.text ? tidied.text : heard[0].toUpperCase() + heard.slice(1);
  const took = [tidied.fillers && `${tidied.fillers} ${tidied.fillers === 1 ? 'um' : 'ums'}`, tidied.repeats && `${tidied.repeats} doubled ${tidied.repeats === 1 ? 'word' : 'words'}`].filter(Boolean);
  line.replaceChildren(shown);
  if (took.length) {
    const note = document.createElement('span');
    note.className = 'took';
    note.textContent = tidyOn.checked ? `Tidied: ${took.join(' and ')} taken out` : `As heard: ${took.join(' and ')} left in`;
    line.append(note);
  }
}

/** The visitor's own words a minute, against the average typist's, once a clip is long enough to say. */
function pace(words, seconds) {
  if (seconds < 3 || words < 6) return;
  const wpm = Math.round((words / seconds) * 60);
  $('pace').textContent = String(wpm);
  $('pace-label').textContent = 'You, just now';
  $('times').textContent = (wpm / TYPING_WPM).toFixed(1);
  $('times-label').textContent = wpm >= TYPING_WPM ? 'Faster than typing it' : 'Of a typist’s pace';
}

/* ---------- the button ---------- */

talk.addEventListener('pointerdown', (event) => {
  if (event.button > 0) return;
  event.preventDefault();
  talk.setPointerCapture?.(event.pointerId);
  if (state === 'recording' && latched) return void finish();
  begin();
});
const release = () => {
  if (state === 'starting') releasedEarly = true;
  if (state !== 'recording' || latched) return;
  if (performance.now() - startedAt >= HOLD_MS) return void finish();
  // A tap, not a hold: keep listening until the next tap.
  latched = true;
  say('Listening. Tap again when you are done.');
  show();
};
for (const sign of ['pointerenter', 'focus']) talk.addEventListener(sign, warmUp);
addEventListener('touchstart', warmUp, { passive: true, once: true });
document.addEventListener('visibilitychange', () => (document.hidden ? letGo() : rewarm()));
lang.addEventListener('change', warmUp);
talk.addEventListener('pointerup', release);
talk.addEventListener('pointercancel', release);
talk.addEventListener('contextmenu', (event) => event.preventDefault());
// The keyboard, on the button: Space or Enter starts, and the same again stops.
talk.addEventListener('keydown', (event) => {
  if (event.key !== ' ' && event.key !== 'Enter') return;
  event.preventDefault();
  if (event.repeat) return;
  if (state === 'recording') return void finish();
  releasedEarly = true;
  begin();
});

$('copy').addEventListener('click', async () => {
  const all = [...text.querySelectorAll('p[data-heard]')].map((p) => p.firstChild?.textContent ?? '').join('\n\n');
  if (!all) return say('Nothing to copy yet.');
  try {
    await navigator.clipboard.writeText(all);
    say('Copied.');
  } catch {
    say('The browser would not copy. Select the text and copy it by hand.', true);
  }
});
$('clear').addEventListener('click', () => {
  if (state !== 'idle') return;
  text.replaceChildren();
  chip('first', '—');
  chip('lag', '—');
  chip('last', '—');
  allowance();
});
keyField.addEventListener('input', allowance);
keyField.addEventListener('change', warmUp);
tidyOn.addEventListener('change', () => text.querySelectorAll('p[data-heard]').forEach(write));

// Space, held anywhere on the page that is not a field or a button, is the button.
const typing = (target) => target instanceof HTMLElement && Boolean(target.closest('input, select, textarea, button, a, summary, [contenteditable]'));
addEventListener('keydown', (event) => {
  if (event.code !== 'Space' || event.repeat || typing(event.target) || event.metaKey || event.ctrlKey || event.altKey) return;
  event.preventDefault();
  if (state === 'recording' && latched) return void finish();
  begin();
});
addEventListener('keyup', (event) => {
  if (event.code !== 'Space' || typing(event.target)) return;
  release();
});

// Framed by the deck's demo slide: say the page is here, so the slide can take its poster away.
if (embedded && parent !== window) parent.postMessage({ type: 'gradium-dictation:ready' }, '*');

show();
// Where the microphone is already allowed, be ready before the first press.
allowance().then(async () => {
  try {
    if ((await navigator.permissions.query({ name: 'microphone' })).state === 'granted') warmUp();
  } catch {
    /* A browser that will not say: the first hover or touch warms it. */
  }
});
