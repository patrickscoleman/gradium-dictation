import { CONFIG } from './config.js';

const API = 'https://api.gradium.ai/api';

/**
 * One clip to Gradium's speech-to-text, over REST
 * (https://docs.gradium.ai/guides/speech-to-text-rest). The answer is a
 * stream of JSON lines, a word or a phrase each, which `wordsFrom` turns
 * into plain text as it arrives. The key goes in a header and nowhere
 * else: never a log line, never an error message.
 */
export async function transcribe({ key, wav, language, signal }) {
  const response = await fetch(`${API}/speech/asr?json_config=${encodeURIComponent(JSON.stringify({ language }))}`, {
    method: 'POST',
    headers: { 'x-api-key': key, 'content-type': 'audio/wav' },
    body: wav,
    signal,
  });
  if (!response.ok || !response.body) {
    // Gradium answers a bad key with a 500 and a line of text that says so.
    const said = (await response.text().catch(() => '')).slice(0, 300);
    const error = new Error(`Gradium answered ${response.status}`);
    error.keyRefused = /api key|unauthori[sz]ed|forbidden|revoked|expired/i.test(said) || response.status === 401 || response.status === 403;
    error.outOfCredits = /credit|quota/i.test(said) || response.status === 402;
    throw error;
  }
  return response.body.pipeThrough(wordsFrom());
}

/** JSON lines in, the text of each `text` line out, a space between them. */
export function wordsFrom() {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let pending = '';
  let sent = false;
  const line = (raw, controller) => {
    if (!raw.trim()) return;
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    if (message?.type !== 'text' || typeof message.text !== 'string' || !message.text.trim()) return;
    controller.enqueue(encoder.encode(`${sent ? ' ' : ''}${message.text.trim()}`));
    sent = true;
  };
  return new TransformStream({
    transform(chunk, controller) {
      pending += decoder.decode(chunk, { stream: true });
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const raw of lines) line(raw, controller);
    },
    flush(controller) {
      line(pending + decoder.decode(), controller);
    },
  });
}

/**
 * Whether the account behind the shared key still has room above the
 * floor, by Gradium's own count (`GET /usages/credits`, free to read). The
 * answer is kept for two minutes. A count that cannot be read is a no: the
 * demo pauses rather than spend blind.
 */
export async function aboveFloor(key, cache) {
  const configured = Number(process.env.GRADIUM_CREDIT_FLOOR);
  const floor = Math.max(CONFIG.creditFloor, Number.isFinite(configured) ? configured : 0);
  const kept = await cache.get('credits');
  let remaining = typeof kept === 'number' ? kept : null;
  if (remaining === null) {
    try {
      const response = await fetch(`${API}/usages/credits`, { headers: { 'x-api-key': key }, signal: AbortSignal.timeout(5_000) });
      const body = response.ok ? await response.json() : null;
      remaining = typeof body?.remaining_credits === 'number' ? body.remaining_credits : null;
    } catch {
      remaining = null;
    }
    if (remaining === null) return false;
    await cache.set('credits', remaining, { ttl: 120 });
  }
  return remaining - CONFIG.clipSeconds * CONFIG.creditsPerSecond >= floor;
}
