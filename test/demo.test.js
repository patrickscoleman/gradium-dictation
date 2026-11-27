import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CONFIG, MAX_BYTES } from '../lib/config.js';
import { wordsFrom } from '../lib/gradium.js';
import { handleStatus, handleTranscribe } from '../lib/handlers.js';
import { createLimits, memoryCache } from '../lib/limits.js';
import { clipSeconds, encodeWav } from '../lib/wav.js';

const clip = (seconds) => encodeWav(new Int16Array(Math.round(seconds * CONFIG.sampleRate)));
// Made up here, so nothing in this file looks like a key to a scanner.
const SHARED = `shared-${'0'.repeat(20)}`;
const OWN = `own-${'1'.repeat(24)}`;
const words = (said = 'hello there') => async () => new Response(said).body;
const post = (body, { key, lang = 'en', headers = {}, address = '203.0.113.7' } = {}) =>
  new Request(`https://demo.example/api/transcribe?lang=${lang}`, {
    method: 'POST',
    headers: { 'content-type': 'audio/wav', 'x-real-ip': address, origin: 'https://demo.example', host: 'demo.example', ...(key ? { 'x-gradium-key': key } : {}), ...headers },
    body,
  });
const fixed = (iso) => () => Date.parse(iso);

test('a clip is as long as its bytes say, and only the format the page records is read', () => {
  assert.equal(clipSeconds(clip(2)), 2);
  assert.equal(clipSeconds(encodeWav(new Int16Array(48_000), 48_000)), null);
  assert.equal(clipSeconds(new Uint8Array(100)), null);
  const lying = clip(1);
  new DataView(lying.buffer).setUint32(40, 10_000_000, true);
  assert.equal(clipSeconds(lying), 1, 'a length past the end is the bytes that are there');
  assert.ok(clip(CONFIG.clipSeconds).byteLength <= MAX_BYTES);
});

test('Gradium’s lines become words with a space between them', async () => {
  const lines = ['{"type":"text","text":"your","start_s":0}', '{"type":"end_text","stop_s":0.4}', '{"type":"text","text":"code is 7429."}', '{"type":"step"}', 'not json', '{"type":"text","text":"  "}'].join('\n');
  // Split mid-line, as a network does.
  const body = new ReadableStream({
    start(controller) {
      const bytes = new TextEncoder().encode(lines);
      controller.enqueue(bytes.subarray(0, 25));
      controller.enqueue(bytes.subarray(25));
      controller.close();
    },
  });
  assert.equal(await new Response(body.pipeThrough(wordsFrom())).text(), 'your code is 7429.');
});

test('the shared key answers a clip and counts it against the day', async () => {
  const cache = memoryCache();
  const now = fixed('2026-11-21T10:00:00Z');
  const response = await handleTranscribe(post(clip(10)), { cache, sharedKey: SHARED, now, send: words(), floor: async () => true });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'hello there');
  assert.equal(response.headers.get('x-key'), 'shared');
  assert.equal(response.headers.get('x-robots-tag'), 'noindex, nofollow');
  assert.equal(await createLimits(cache, now).remainingToday(), CONFIG.dailySeconds - 10);
  const status = await (await handleStatus(new Request('https://demo.example/api/status'), { cache, sharedKey: SHARED, now })).json();
  assert.deepEqual(status, { shared: true, remainingSeconds: CONFIG.dailySeconds - 10, dailySeconds: CONFIG.dailySeconds, clipSeconds: CONFIG.clipSeconds });
});

test('past the day’s allowance the demo pauses, and a new day opens it again', async () => {
  const cache = memoryCache();
  const now = fixed('2026-11-21T10:00:00Z');
  let calls = 0;
  const send = async () => (calls++, new Response('ok').body);
  const whole = CONFIG.dailySeconds / CONFIG.clipSeconds;
  for (let i = 0; i < whole; i++) {
    // A new address each time: this is the day's limit, not one visitor's.
    const response = await handleTranscribe(post(clip(CONFIG.clipSeconds), { address: `198.51.100.${i}` }), { cache, sharedKey: SHARED, now, send, floor: async () => true });
    assert.equal(response.status, 200, `clip ${i}`);
  }
  const refused = await handleTranscribe(post(clip(1), { address: '192.0.2.1' }), { cache, sharedKey: SHARED, now, send, floor: async () => true });
  assert.equal(refused.status, 429);
  assert.match((await refused.json()).message, /Demo paused for today/);
  assert.equal(calls, whole, 'a refused clip never reaches Gradium');
  const tomorrow = await handleTranscribe(post(clip(1), { address: '192.0.2.1' }), { cache, sharedKey: SHARED, now: fixed('2026-11-22T00:00:01Z'), send, floor: async () => true });
  assert.equal(tomorrow.status, 200);
});

test('one address has a share of the day and a pace', async () => {
  const cache = memoryCache();
  const now = fixed('2026-11-21T10:00:00Z');
  const options = { cache, sharedKey: SHARED, now, send: words(), floor: async () => true };
  for (let i = 0; i < CONFIG.visitorClips; i++) assert.equal((await handleTranscribe(post(clip(1)), options)).status, 200);
  const paced = await handleTranscribe(post(clip(1)), options);
  assert.equal((await paced.json()).error, 'slow_down');
  assert.ok(Number(paced.headers.get('retry-after')) > 0);
  // Later the same day, long clips three minutes apart run into the visitor's share.
  const at = (i) => ({ ...options, now: () => Date.parse('2026-11-21T15:00:00Z') + i * 180_000 });
  let last;
  let i = 0;
  for (; i < CONFIG.visitorDailySeconds / CONFIG.clipSeconds + 1; i++) last = await handleTranscribe(post(clip(CONFIG.clipSeconds)), at(i));
  assert.equal((await last.json()).error, 'visitor_limit');
  const later = at(i);
  assert.equal((await handleTranscribe(post(clip(1), { address: '192.0.2.9' }), later)).status, 200, 'another address is not held to it');
});

test('a visitor’s own key skips the shared allowance and is the key Gradium gets', async () => {
  const cache = memoryCache();
  const now = fixed('2026-11-21T10:00:00Z');
  const own = OWN;
  let used;
  const send = async ({ key }) => ((used = key), new Response('mine').body);
  const floor = async () => assert.fail('the floor is the shared key’s');
  const response = await handleTranscribe(post(clip(20), { key: own }), { cache, sharedKey: SHARED, now, send, floor });
  assert.equal(response.status, 200);
  assert.equal(used, own);
  assert.equal(response.headers.get('x-key'), 'own');
  assert.equal(await createLimits(cache, now).remainingToday(), CONFIG.dailySeconds);
  // And it works when there is no shared key at all.
  assert.equal((await handleTranscribe(post(clip(2), { key: own }), { cache, sharedKey: '', now, send, floor })).status, 200);
  assert.equal((await handleTranscribe(post(clip(2)), { cache, sharedKey: '', now, send, floor })).status, 503);
  assert.equal((await handleTranscribe(post(clip(2), { key: 'short' }), { cache, sharedKey: SHARED, now, send, floor })).status, 400);
});

test('the credit floor pauses the shared key before anything is counted or sent', async () => {
  const cache = memoryCache();
  const now = fixed('2026-11-21T10:00:00Z');
  const send = async () => assert.fail('nothing is sent below the floor');
  const response = await handleTranscribe(post(clip(5)), { cache, sharedKey: SHARED, now, send, floor: async () => false });
  assert.equal(response.status, 429);
  assert.equal((await response.json()).error, 'paused_today');
  assert.equal(await createLimits(cache, now).remainingToday(), CONFIG.dailySeconds);
});

test('what is not a clip from the demo’s own page is refused before any limit is touched', async () => {
  const options = { cache: memoryCache(), sharedKey: SHARED, send: async () => assert.fail('never sent'), floor: async () => assert.fail('never read') };
  assert.equal((await handleTranscribe(new Request('https://demo.example/api/transcribe'), options)).status, 405);
  assert.equal((await handleTranscribe(post(clip(2), { headers: { origin: 'https://elsewhere.example' } }), options)).status, 403);
  assert.equal((await handleTranscribe(post(clip(2), { headers: { 'sec-fetch-site': 'cross-site' } }), options)).status, 403);
  assert.equal((await handleTranscribe(post(clip(2), { lang: 'xx' }), options)).status, 400);
  assert.equal((await handleTranscribe(post(clip(2), { headers: { 'content-type': 'audio/webm' } }), options)).status, 415);
  assert.equal((await handleTranscribe(post(new Uint8Array(2000)), options)).status, 415);
  assert.equal((await handleTranscribe(post(clip(0.1)), options)).status, 422);
  assert.equal((await handleTranscribe(post(clip(CONFIG.clipSeconds + 5)), options)).status, 413);
});

test('a key Gradium refuses is said plainly, and the key is in no message', async () => {
  const own = OWN;
  const refused = Object.assign(new Error('Gradium answered 500'), { keyRefused: true });
  const logged = [];
  const error = console.error;
  console.error = (line) => logged.push(String(line));
  try {
    const response = await handleTranscribe(post(clip(2), { key: own }), { cache: memoryCache(), sharedKey: SHARED, send: async () => Promise.reject(refused), floor: async () => true });
    assert.equal(response.status, 401);
    const body = JSON.stringify(await response.json());
    assert.ok(!body.includes(own) && !logged.join(' ').includes(own));
  } finally {
    console.error = error;
  }
});

test('the configured shared key is disabled for status and French clips', async (t) => {
  const previous = process.env.GRADIUM_API_KEY;
  process.env.GRADIUM_API_KEY = SHARED;
  t.after(() => {
    if (previous === undefined) delete process.env.GRADIUM_API_KEY;
    else process.env.GRADIUM_API_KEY = previous;
  });
  const options = {
    cache: memoryCache(),
    floor: async () => assert.fail('the shared credit balance must not be read'),
    send: async ({ key, language }) => {
      assert.equal(key, OWN);
      assert.equal(language, 'fr');
      return new Response('bonjour').body;
    },
  };
  const status = await handleStatus(new Request('https://demo.example/api/status'), options);
  const { shared, remainingSeconds } = await status.json();
  assert.equal(shared, false);
  assert.equal(remainingSeconds, 0);
  const refused = await handleTranscribe(post(clip(1), { lang: 'fr' }), options);
  assert.equal(refused.status, 503);
  const refusal = await refused.json();
  assert.equal(refusal.error, 'no_key');
  assert.match(refusal.message, /Paste your own Gradium key/);
  const own = await handleTranscribe(post(clip(1), { lang: 'fr', key: OWN }), options);
  assert.equal(own.headers.get('x-key'), 'own');
  assert.equal(await own.text(), 'bonjour');
});
