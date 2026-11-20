import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { CONFIG } from '../lib/config.js';
import { createLimits, memoryCache } from '../lib/limits.js';
import { liveRequest, relay } from '../lib/live.js';

/** A socket that keeps what was sent to it. */
class Socket extends EventEmitter {
  readyState = 1;
  sent = [];
  closed = null;
  send(data) {
    this.sent.push(typeof data === 'string' ? JSON.parse(data) : data);
  }
  close(code) {
    if (this.readyState !== 1) return;
    this.readyState = 3;
    this.closed = code ?? 1000;
    this.emit('close');
  }
}
const SHARED = `shared-${'0'.repeat(20)}`;
const OWN = `own-${'1'.repeat(24)}`;
const second = (n = 1) => Buffer.alloc(CONFIG.sampleRate * 2 * n);
const settle = () => new Promise((done) => setTimeout(done, 5));
const now = () => Date.parse('2026-11-21T10:00:00Z');

/** A press on a fresh relay: the browser's socket, Gradium's, and the key it was opened with. */
function press(options = {}) {
  const client = new Socket();
  const gradium = new Socket();
  const used = [];
  const cache = options.cache ?? memoryCache();
  relay(client, { language: 'en', address: '203.0.113.7', cache, sharedKey: SHARED, now, floor: async () => true, connect: (key) => (used.push(key), gradium), ...options });
  return { client, gradium, used, cache };
}
const types = (socket) => socket.sent.map((message) => message.type);

test('a press is set up at the lowest delay, relayed word by word, and ended on release', async () => {
  const { client, gradium, used, cache } = press();
  client.emit('message', JSON.stringify({ type: 'start' }), false);
  await settle();
  assert.deepEqual(used, [SHARED]);
  gradium.emit('open');
  assert.deepEqual(gradium.sent[0], { type: 'setup', model_name: 'default', input_format: 'pcm_16000', json_config: { language: 'en', delay_in_frames: 7 } });
  // Said before Gradium was ready: kept and sent in order once it is.
  client.emit('message', second(), true);
  gradium.emit('message', JSON.stringify({ type: 'ready', delay_in_frames: 7 }));
  client.emit('message', second(2), true);
  assert.deepEqual(types(gradium), ['setup', 'audio', 'audio']);
  gradium.emit('message', JSON.stringify({ type: 'text', text: 'hello', start_s: 0.2, stream_id: 0 }));
  gradium.emit('message', JSON.stringify({ type: 'step', vad: [] }));
  gradium.emit('message', JSON.stringify({ type: 'end_text', stop_s: 0.6 }));
  const { took, ...readyMessage } = client.sent[0];
  assert.deepEqual(readyMessage, { type: 'ready', delay_in_frames: 7, key: 'shared' });
  assert.deepEqual(Object.keys(took).sort(), ['admit', 'connect', 'setup', 'warm'], 'the press says how long each step took');
  assert.deepEqual(client.sent.slice(1), [{ type: 'text', text: 'hello', start_s: 0.2 }, { type: 'end_text', stop_s: 0.6 }]);
  client.emit('message', JSON.stringify({ type: 'flush' }), false);
  assert.deepEqual(types(gradium).slice(-2), ['flush', 'end_of_stream']);
  client.emit('message', second(), true);
  assert.equal(types(gradium).filter((t) => t === 'audio').length, 2, 'nothing is sent after release');
  gradium.emit('message', JSON.stringify({ type: 'flushed', flush_id: 1 }));
  gradium.emit('message', JSON.stringify({ type: 'end_of_stream' }));
  assert.deepEqual(client.sent.slice(-2), [{ type: 'flushed', final: true }, { type: 'done', seconds: 3, why: 'released' }]);
  assert.equal(client.closed, 1000);
  await settle();
  // Held for a whole clip, charged for the three seconds it sent.
  assert.equal(await createLimits(cache, now).remainingToday(), CONFIG.dailySeconds - 3);
});

test('the server ends a press at a clip’s length, whatever the browser sends', async () => {
  const { client, gradium, cache } = press();
  client.emit('message', JSON.stringify({ type: 'start' }), false);
  await settle();
  gradium.emit('open');
  gradium.emit('message', JSON.stringify({ type: 'ready' }));
  for (let i = 0; i < CONFIG.clipSeconds + 20; i++) client.emit('message', second(), true);
  const audio = gradium.sent.filter((m) => m.type === 'audio').reduce((bytes, m) => bytes + Buffer.from(m.audio, 'base64').length, 0);
  assert.equal(audio, CONFIG.clipSeconds * CONFIG.sampleRate * 2);
  assert.deepEqual(types(gradium).slice(-2), ['flush', 'end_of_stream']);
  assert.ok(types(client).includes('limit'));
  gradium.emit('message', JSON.stringify({ type: 'end_of_stream' }));
  await settle();
  assert.equal(await createLimits(cache, now).remainingToday(), CONFIG.dailySeconds - CONFIG.clipSeconds);
});

test('past the day’s allowance a press is refused before Gradium is called', async () => {
  const cache = memoryCache();
  await cache.set('day:2026-11-21', CONFIG.dailySeconds - 10);
  const { client, gradium } = press({ cache });
  client.emit('message', JSON.stringify({ type: 'start' }), false);
  await settle();
  // Its socket may have been opened while the press was counted; nothing was sent on it, and it is closed.
  assert.deepEqual(gradium.sent.filter((m) => m.type === 'audio'), []);
  assert.equal(gradium.readyState, 3);
  assert.equal(client.sent[0].type, 'refused');
  assert.match(client.sent[0].message, /Demo paused for today/);
  assert.equal(client.closed, 1008);
  const floored = press({ floor: async () => false });
  floored.client.emit('message', JSON.stringify({ type: 'start' }), false);
  await settle();
  assert.equal(floored.client.sent[0].error, 'paused_today');
  assert.deepEqual(floored.used, [], 'under the floor, Gradium is not called at all');
});

test('a press that looked likely finds Gradium already listening, and has cost nobody anything', async () => {
  const { client, gradium, used, cache } = press();
  client.emit('message', JSON.stringify({ type: 'warm', lang: 'fr' }), false);
  await settle();
  assert.deepEqual(used, [SHARED]);
  gradium.emit('open');
  assert.equal(gradium.sent[0].json_config.language, 'fr');
  gradium.emit('message', JSON.stringify({ type: 'ready' }));
  assert.equal(client.sent[0].type, 'warm');
  assert.equal(await createLimits(cache, now).remainingToday(), CONFIG.dailySeconds, 'nothing is held until the press');
  // Audio before the press is not a press.
  client.emit('message', second(), true);
  assert.equal(gradium.sent.filter((m) => m.type === 'audio').length, 0);
  client.emit('message', JSON.stringify({ type: 'start', lang: 'fr' }), false);
  await settle();
  assert.deepEqual(used, [SHARED], 'the same socket, not a second one');
  assert.equal(client.sent[1].type, 'ready');
  client.emit('message', second(), true);
  assert.equal(gradium.sent.filter((m) => m.type === 'audio').length, 1);
  client.emit('close');
});

test('a socket opened ahead for another language is not used for the press', async () => {
  const sockets = [];
  const client = new Socket();
  relay(client, { language: 'en', address: '203.0.113.7', cache: memoryCache(), sharedKey: SHARED, now, floor: async () => true, connect: () => (sockets.push(new Socket()), sockets.at(-1)) });
  client.emit('message', JSON.stringify({ type: 'warm', lang: 'en' }), false);
  await settle();
  sockets[0].emit('open');
  sockets[0].emit('message', JSON.stringify({ type: 'ready' }));
  client.emit('message', JSON.stringify({ type: 'start', lang: 'de' }), false);
  await settle();
  assert.equal(sockets.length, 2);
  assert.equal(sockets[0].readyState, 3);
  sockets[1].emit('open');
  assert.equal(sockets[1].sent[0].json_config.language, 'de');
  assert.equal(client.closed, null, 'the first socket closing does not end the press');
  client.emit('close');
});

test('a paused day is known before the press, and said at it', async () => {
  const { client, used } = press({ floor: async () => false });
  client.emit('message', JSON.stringify({ type: 'warm' }), false);
  await settle();
  assert.deepEqual(used, []);
  client.emit('message', JSON.stringify({ type: 'start' }), false);
  await settle();
  assert.equal(client.sent[0].error, 'paused_today');
  assert.deepEqual(used, []);
});

test('a visitor’s own key is the key Gradium gets, and the shared allowance is untouched', async () => {
  const { client, gradium, used, cache } = press({ floor: async () => assert.fail('the floor is the shared key’s') });
  client.emit('message', JSON.stringify({ type: 'start', key: OWN }), false);
  await settle();
  assert.deepEqual(used, [OWN]);
  gradium.emit('open');
  gradium.emit('message', JSON.stringify({ type: 'ready' }));
  assert.equal(client.sent[0].key, 'own');
  client.emit('message', second(5), true);
  client.emit('close');
  await settle();
  assert.equal(await createLimits(cache, now).remainingToday(), CONFIG.dailySeconds);
  assert.equal(gradium.readyState, 3, 'Gradium’s socket is closed when the visitor leaves');
  const bad = press();
  bad.client.emit('message', JSON.stringify({ type: 'start', key: 'short' }), false);
  await settle();
  assert.equal(bad.client.sent[0].error, 'bad_key');
});

test('what Gradium says about a key never reaches the page', async () => {
  const logged = [];
  const error = console.error;
  console.error = (line) => logged.push(String(line));
  try {
    const { client, gradium } = press();
    client.emit('message', JSON.stringify({ type: 'start', key: OWN }), false);
    await settle();
    gradium.emit('open');
    gradium.emit('message', JSON.stringify({ type: 'error', message: `API key ${OWN} is revoked or expired`, code: 1008 }));
    assert.equal(client.sent[0].error, 'key_refused');
    assert.ok(!JSON.stringify(client.sent).includes(OWN) && !logged.join(' ').includes(OWN));
  } finally {
    console.error = error;
  }
});

test('only the demo’s own page may open a live socket', () => {
  const ask = (headers, query = '?lang=fr') => liveRequest(new Request(`https://demo.example/api/live${query}`, { headers: { host: 'demo.example', ...headers } }));
  assert.deepEqual(ask({ origin: 'https://demo.example', 'x-real-ip': '203.0.113.7' }), { language: 'fr', address: '203.0.113.7' });
  assert.equal(ask({ origin: 'https://elsewhere.example' }).refuse, 'elsewhere');
  assert.equal(ask({}).refuse, 'elsewhere', 'no origin is not the page');
  assert.equal(ask({ origin: 'https://demo.example' }, '?lang=xx').refuse, 'language');
});

test('a pause mid-press asks Gradium for the words it is holding, and the press goes on', async () => {
  let at = 0;
  const { client, gradium } = press({ clock: () => at });
  client.emit('message', JSON.stringify({ type: 'start' }), false);
  await settle();
  gradium.emit('open');
  gradium.emit('message', JSON.stringify({ type: 'ready', delay_in_frames: 7 }));
  client.emit('message', second(), true);
  at = 5_000;
  client.emit('message', JSON.stringify({ type: 'pause' }), false);
  assert.deepEqual(gradium.sent.at(-1), { type: 'flush', flush_id: 2 }, 'a flush of its own number, and no end of stream');
  // Told again at once: one flush is enough for one breath.
  client.emit('message', JSON.stringify({ type: 'pause' }), false);
  assert.equal(types(gradium).filter((t) => t === 'flush').length, 1);
  gradium.emit('message', JSON.stringify({ type: 'flushed', flush_id: 2 }));
  assert.deepEqual(client.sent.at(-1), { type: 'flushed', final: false });
  assert.equal(client.closed, null, 'the press is still open');
  client.emit('message', second(), true);
  assert.equal(types(gradium).filter((t) => t === 'audio').length, 2, 'audio goes on after the pause');
  at = 9_000;
  client.emit('message', JSON.stringify({ type: 'flush' }), false);
  assert.deepEqual(gradium.sent.slice(-2), [{ type: 'flush', flush_id: 1 }, { type: 'end_of_stream' }]);
});
