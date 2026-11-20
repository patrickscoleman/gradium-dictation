/**
 * The demo's limits, in one place. The shared key is Patrick's and spends
 * his credits, so every number here is a ceiling on that, and the README
 * says what each costs.
 *
 * Gradium bills speech-to-text at 3 credits a second (gradium.ai/pricing,
 * read 2026-11-20). A day's shared allowance of 14,400 seconds (4 hours) is
 * 43,200 credits: about $2.30 at the XS plan's own rate ($12 for 225,000) and
 * $3.02 at its top-up rate ($7 for 100,000). Raised from 30 minutes on
 * 2026-11-20 at Patrick's ask: the link is not public, and the interview must
 * not hit a limit in normal use. The credit floor below is unchanged.
 */
export const CONFIG = Object.freeze({
  /** The longest clip a visitor may send, in seconds. */
  clipSeconds: 30,
  /** The shortest worth sending. */
  minSeconds: 0.4,
  /** Every clip is 16 kHz, 16-bit, mono WAV, as the page records it. */
  sampleRate: 16_000,
  /** Shared key: seconds of audio for everybody together, per UTC day. */
  dailySeconds: 14_400,
  /** Shared key: seconds for one address, per UTC day. */
  visitorDailySeconds: 4_800,
  /** Shared key: clips for one address in one window. */
  visitorClips: 100,
  /** A visitor's own key: clips for one address in one window. */
  ownKeyClips: 100,
  windowSeconds: 600,
  /**
   * Live dictation: how far behind the voice Gradium may run, in 80 ms
   * frames. 7 is the least it allows, about 0.56 s.
   */
  delayInFrames: 7,
  /** A socket opened ahead of a press may wait this long for it. */
  helloSeconds: 20,
  /** Gradium sockets one instance may hold open ahead of a press. The account allows 20 sessions at once. */
  socketsAhead: 6,
  /** A live press that sends no audio for this long is over. */
  quietSeconds: 6,
  /** A live press may wait this long, in all, for Gradium to finish. */
  wallSeconds: 45,
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
