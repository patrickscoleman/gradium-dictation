// gradium-dictation, the web demo: record a clip, send it, read the words
// as they come back. Nothing is kept: no storage, no cookies.
import { cloud } from './cloud.js';
import { tidy, wordCount } from './tidy.js';

const CLIP_SECONDS = 30;
const RATE = 16_000;
const HOLD_MS = 400;
const COLUMNS = 14;
const DOTS = 5;

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
/** What an average typist manages: Dhakal et al., CHI 2018, 168,000 volunteers. */
const TYPING_WPM = 52;

/** 'idle' | 'starting' | 'recording' | 'sending' */
let state = 'idle';
let context;
let stream;
let node;
let batches = [];
let startedAt = 0;
let latched = false;
let releasedEarly = false;
let ticker;
let levels = new Array(COLUMNS).fill(0);

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
}
drawMeter();

/* ---------- saying things ---------- */

function say(message, warn = false) {
  status.textContent = message;
  status.classList.toggle('warn', warn);
}

function show() {
  talk.setAttribute('aria-pressed', String(state === 'recording'));
  talk.disabled = state === 'sending';
  label.textContent = state === 'recording' ? (latched ? 'Tap to stop' : 'Listening') : state === 'sending' ? 'Transcribing' : state === 'starting' ? 'Starting' : 'Hold to talk';
  if (state !== 'recording') clock.textContent = `0:${String(CLIP_SECONDS).padStart(2, '0')}`;
}

async function allowance() {
  if (keyField.value.trim()) return say('Using your own Gradium key. The shared limit does not apply.');
  try {
    const answer = await (await fetch('/api/status', { cache: 'no-store' })).json();
    if (!answer.shared) return say('The shared demo key is not set up yet. Paste your own Gradium key further down to try it.', true);
    if (answer.remainingSeconds < 1) return say('Demo paused for today. Paste your own Gradium key further down, or come back tomorrow.', true);
    const minutes = Math.floor(answer.remainingSeconds / 60);
    say(`Shared demo: ${minutes >= 1 ? `${minutes} min` : `${Math.floor(answer.remainingSeconds)} s`} of today’s ${Math.round(answer.dailySeconds / 60)} left for everyone.`);
  } catch {
    say('');
  }
}

/* ---------- recording ---------- */

function microphoneProblem(error) {
  if (!navigator.mediaDevices?.getUserMedia) return 'This browser cannot record here. Try a current Safari, Chrome or Firefox over https.';
  if (error?.name === 'NotAllowedError' || error?.name === 'SecurityError') return 'The microphone is blocked for this page. Allow it in the browser’s site settings, then press the button again.';
  if (error?.name === 'NotFoundError') return 'No microphone was found.';
  return 'The microphone could not be started. Press the button to try again.';
}

async function begin() {
  if (state !== 'idle') return;
  state = 'starting';
  releasedEarly = false;
  latched = false;
  show();
  try {
    // Made inside the press, before anything is awaited: Safari starts an
    // audio context only from a gesture.
    context ??= new AudioContext();
    const awake = context.resume();
    stream ??= await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    await awake;
    if (!node) {
      await context.audioWorklet.addModule('/recorder-worklet.js');
      node = new AudioWorkletNode(context, 'recorder');
      node.port.onmessage = (event) => {
        if (state !== 'recording') return;
        batches.push(event.data);
        hear(event.data);
      };
      // Through a silent gain to the output, so the graph is pulled and nothing is heard.
      const silent = context.createGain();
      silent.gain.value = 0;
      context.createMediaStreamSource(stream).connect(node).connect(silent).connect(context.destination);
    }
  } catch (error) {
    state = 'idle';
    show();
    say(microphoneProblem(error), true);
    return;
  }
  batches = [];
  startedAt = performance.now();
  state = 'recording';
  // A press let go while the browser was still asking for the microphone is a tap.
  latched = releasedEarly;
  $('hint')?.remove();
  say(latched ? 'Listening. Tap the button again when you are done.' : 'Listening.');
  show();
  ticker = setInterval(() => {
    const left = CLIP_SECONDS - (performance.now() - startedAt) / 1000;
    clock.textContent = `0:${String(Math.max(0, Math.ceil(left))).padStart(2, '0')}`;
    if (left <= 0) finish();
  }, 200);
}

/** The recording at 16 kHz: each output sample is the mean of the input samples it covers. */
function resample(input, from) {
  const ratio = from / RATE;
  const out = new Int16Array(Math.floor(input.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.max(start + 1, Math.min(input.length, Math.floor((i + 1) * ratio)));
    let sum = 0;
    for (let k = start; k < end; k++) sum += input[k];
    out[i] = Math.max(-1, Math.min(1, sum / (end - start))) * 0x7fff;
  }
  return out;
}

function wav(samples) {
  const bytes = new DataView(new ArrayBuffer(44 + samples.length * 2));
  const write = (at, word) => [...word].forEach((c, i) => bytes.setUint8(at + i, c.charCodeAt(0)));
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
  const released = performance.now();
  // The last syllable is still on its way through the worklet.
  await new Promise((done) => setTimeout(done, 140));
  state = 'sending';
  show();
  context.suspend();
  levels = new Array(COLUMNS).fill(0);
  drawMeter();

  const whole = new Float32Array(batches.reduce((n, batch) => n + batch.length, 0));
  let at = 0;
  for (const batch of batches) {
    whole.set(batch, at);
    at += batch.length;
  }
  batches = [];
  const samples = resample(whole, context.sampleRate).subarray(0, CLIP_SECONDS * RATE);
  if (samples.length < RATE * 0.4) {
    state = 'idle';
    show();
    return say('That was too short to hear. Hold the button a little longer.', true);
  }
  await send(wav(samples), samples.length / RATE, released);
  state = 'idle';
  show();
}

/* ---------- sending ---------- */

async function send(clip, seconds, released) {
  const line = document.createElement('p');
  line.className = 'live';
  text.append(line);
  text.scrollTop = text.scrollHeight;
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
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      line.textContent += decoder.decode(value, { stream: true });
      text.scrollTop = text.scrollHeight;
    }
    line.className = '';
    const said = line.textContent.trim();
    if (!said) {
      line.remove();
      return say('No words were heard in that clip. Try again, a little closer to the microphone.', true);
    }
    line.dataset.heard = said;
    line.dataset.language = lang.value;
    write(line);
    const words = wordCount(said);
    const ms = Math.round(performance.now() - released);
    say(`${words} words in ${seconds.toFixed(1)} s of speech · text ${(ms / 1000).toFixed(1)} s after you stopped`);
    pace(words, seconds);
    setTimeout(() => state === 'idle' && allowance(), 8000);
  } catch {
    line.remove();
    say('The demo could not be reached. Check the connection and try again.', true);
  }
}

/* ---------- tidying, and how fast that was ---------- */

/** Draw a clip's line: tidied or as it was heard, with what the tidy-up took out. */
function write(line) {
  const heard = line.dataset.heard;
  const tidied = tidy(heard, line.dataset.language);
  const text = tidyOn.checked && tidied.text ? tidied.text : heard;
  const took = [tidied.fillers && `${tidied.fillers} ${tidied.fillers === 1 ? 'um' : 'ums'}`, tidied.repeats && `${tidied.repeats} doubled ${tidied.repeats === 1 ? 'word' : 'words'}`].filter(Boolean);
  line.replaceChildren(text);
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
  say('Listening. Tap the button again when you are done.');
  show();
};
talk.addEventListener('pointerup', release);
talk.addEventListener('pointercancel', release);
talk.addEventListener('contextmenu', (event) => event.preventDefault());
// The keyboard: Space or Enter starts, and the same again stops.
talk.addEventListener('keydown', (event) => {
  if (event.key !== ' ' && event.key !== 'Enter') return;
  event.preventDefault();
  if (event.repeat) return;
  if (state === 'recording') return void finish();
  releasedEarly = true;
  begin();
});

$('copy').addEventListener('click', async () => {
  const all = [...text.querySelectorAll('p:not(.hint)')].map((p) => p.firstChild?.textContent ?? '').join('\n\n');
  if (!all) return say('Nothing to copy yet.');
  try {
    await navigator.clipboard.writeText(all);
    say('Copied.');
  } catch {
    say('The browser would not copy. Select the text and copy it by hand.', true);
  }
});
$('clear').addEventListener('click', () => {
  text.replaceChildren();
  say('');
  allowance();
});
keyField.addEventListener('change', allowance);
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

show();
allowance();
