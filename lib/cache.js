import { getCache } from '@vercel/functions';
import { memoryCache } from './limits.js';

let fallback;

/**
 * The project's Runtime Cache: shared by every instance in the region,
 * with nothing to set up. If it cannot be had, a Map in this instance
 * stands in, and the credit floor in `gradium.js` is then what holds.
 */
export function sharedCache() {
  try {
    return getCache({ namespace: 'dictation-demo' });
  } catch {
    fallback ??= memoryCache();
    return fallback;
  }
}
