import { createHash } from 'node:crypto';
import { CONFIG } from './config.js';

/**
 * Who may send a clip, counted in a small shared cache (on Vercel, the
 * project's Runtime Cache in the one region the functions run in; in a
 * test, a Map).
 *
 * A clip on the shared key is counted before Gradium is called, at its full
 * length, and never given back: a failed call still spent the allowance, so
 * the count can only run ahead of the bill. Reading and writing a count are
 * two steps, so two clips at the same instant can both be let in at the
 * very end of a day's allowance; the day can overrun by a clip, not more.
 *
 * An address is kept only as a hash salted with the day, so the cache never
 * holds one and yesterday's cannot be matched to today's.
 */
export function createLimits(cache, now = () => Date.now()) {
  const day = () => new Date(now()).toISOString().slice(0, 10);
  const window = () => Math.floor(now() / 1000 / CONFIG.windowSeconds);
  const who = (address) => createHash('sha256').update(`${day()}|${address || 'unknown'}`).digest('hex').slice(0, 24);
  const read = async (key) => {
    const value = await cache.get(key);
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
  };
  const add = (key, amount, ttl) => read(key).then((value) => cache.set(key, value + amount, { ttl }));
  const untilWindowEnds = () => Math.ceil((window() + 1) * CONFIG.windowSeconds - now() / 1000);

  return {
    /** Seconds of the day's shared allowance still unspent. */
    async remainingToday() {
      return Math.max(0, CONFIG.dailySeconds - (await read(`day:${day()}`)));
    },

    /**
     * Let one clip in, or say why not. `own` is a visitor's own key: only
     * the pace is limited then, since the credits are theirs.
     */
    async admit({ address, seconds, own }) {
      const id = who(address);
      const cost = Math.ceil(seconds);
      const paceKey = `pace:${own ? 'own' : 'shared'}:${id}:${window()}`;
      if ((await read(paceKey)) >= (own ? CONFIG.ownKeyClips : CONFIG.visitorClips)) return { ok: false, reason: 'slow_down', retryAfter: untilWindowEnds() };
      if (!own) {
        if ((await read(`day:${day()}`)) + cost > CONFIG.dailySeconds) return { ok: false, reason: 'paused_today' };
        if ((await read(`visitor:${id}`)) + cost > CONFIG.visitorDailySeconds) return { ok: false, reason: 'visitor_limit' };
        await add(`day:${day()}`, cost, 2 * 86_400);
        await add(`visitor:${id}`, cost, 86_400);
      }
      await add(paceKey, 1, 2 * CONFIG.windowSeconds);
      return { ok: true };
    },
  };
}

/** A Map with the cache's three calls, for tests and for a machine with no cache. */
export function memoryCache() {
  const held = new Map();
  return {
    get: async (key) => held.get(key) ?? null,
    set: async (key, value) => void held.set(key, value),
    delete: async (key) => void held.delete(key),
  };
}
