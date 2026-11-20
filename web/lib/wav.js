import { CONFIG } from './config.js';

/**
 * Read a clip's header and say how long it is. The page always records
 * 16 kHz, 16-bit, mono PCM, so anything else is refused: the length the
 * limits count is then a fact of the bytes, not something the sender says.
 */
export function clipSeconds(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (at) => String.fromCharCode(view.getUint8(at), view.getUint8(at + 1), view.getUint8(at + 2), view.getUint8(at + 3));
  if (bytes.byteLength < 44 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return null;
  let at = 12;
  let format = null;
  while (at + 8 <= bytes.byteLength) {
    const id = tag(at);
    const size = view.getUint32(at + 4, true);
    if (id === 'fmt ') {
      if (size < 16 || at + 24 > bytes.byteLength) return null;
      format = { pcm: view.getUint16(at + 8, true) === 1, channels: view.getUint16(at + 10, true), rate: view.getUint32(at + 12, true), bits: view.getUint16(at + 22, true) };
    } else if (id === 'data') {
      if (!format || !format.pcm || format.channels !== 1 || format.rate !== CONFIG.sampleRate || format.bits !== 16) return null;
      // A length that runs past the end is the bytes that are really there.
      const samples = Math.min(size, bytes.byteLength - at - 8);
      return samples / (CONFIG.sampleRate * 2);
    }
    at += 8 + size + (size % 2);
  }
  return null;
}

/** 16-bit mono PCM samples as a WAV file. Used by the page (a copy of this lives in `public/app.js`) and the tests. */
export function encodeWav(samples, rate = CONFIG.sampleRate) {
  const bytes = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(bytes.buffer);
  const write = (at, text) => [...text].forEach((c, i) => view.setUint8(at + i, c.charCodeAt(0)));
  write(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  write(8, 'WAVE');
  write(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  write(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) view.setInt16(44 + i * 2, samples[i], true);
  return bytes;
}
