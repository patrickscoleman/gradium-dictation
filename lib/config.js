/**
 * The demo's limits, in one place. The shared key is Patrick's and spends
 * his credits, so every number here is a ceiling on that, and the README
 * says what each costs.
 *
 * Gradium bills speech-to-text at 3 credits a second (gradium.ai/pricing,
 * read 2026-11-20). A day's shared allowance of 1,800 seconds is 5,400
 * credits: about 29 cents at the XS plan's own rate ($12 for 225,000) and
 * 38 cents at its top-up rate ($7 for 100,000).
 */
export const CONFIG = Object.freeze({
  /** The longest clip a visitor may send, in seconds. */
  clipSeconds: 30,
  /** The shortest worth sending. */
  minSeconds: 0.4,
  /** Every clip is 16 kHz, 16-bit, mono WAV, as the page records it. */
  sampleRate: 16_000,
  /** Shared key: seconds of audio for everybody together, per UTC day. */
  dailySeconds: 1_800,
  /** Shared key: seconds for one address, per UTC day. */
  visitorDailySeconds: 300,
  /** Shared key: clips for one address in one window. */
  visitorClips: 8,
  /** A visitor's own key: clips for one address in one window. */
  ownKeyClips: 40,
  windowSeconds: 600,
  /** Gradium's price, for the README and the status line. */
  creditsPerSecond: 3,
  /**
   * The shared key never takes the account below this many credits, whatever
   * the day's counter says: the last line of defence if the counter is lost.
   * `GRADIUM_CREDIT_FLOOR` may raise it, never lower it.
   */
  creditFloor: 120_000,
});

export const LANGUAGES = Object.freeze(['en', 'fr', 'de', 'es', 'pt', 'any']);

/** The most bytes a clip can be: its header and `clipSeconds` of samples, with a little slack. */
export const MAX_BYTES = 44 + Math.ceil(CONFIG.sampleRate * 2 * (CONFIG.clipSeconds + 0.5));
