// Tidy what was heard: take out the ums, the doubled words and the stray
// spaces, and start sentences with a capital. Rules, not a rewrite: every
// word that stays is one the speaker said, in the order they said it.

const FILLERS = {
  any: ['um', 'umm', 'uhm', 'uh', 'uhh', 'er', 'erm', 'hmm', 'hm', 'mm', 'mhm', 'euh'],
  en: ['ah'],
  fr: ['heu', 'hum', 'bah', 'ben'],
  de: ['äh', 'ähm', 'öh'],
  es: ['eh', 'em', 'ehm'],
  pt: ['hã', 'ahn', 'hum'],
};
/** Words that are sometimes said twice on purpose. */
const MEANT = new Set(['had', 'that', 'is', 'no', 'so', 'very', 'really', 'bye', 'nous', 'vous']);

const bare = (word) => word.toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
const ending = (word) => /[.!?…]["’”)]*$/.exec(word)?.[0] ?? '';

/**
 * `{ text, fillers, repeats }`: the tidied text and how much was taken out.
 * `language` is the page's choice; "any" uses every list.
 */
export function tidy(heard, language = 'en') {
  const fillers = new Set([...FILLERS.any, ...(language === 'any' ? Object.values(FILLERS).flat() : (FILLERS[language] ?? []))]);
  const kept = [];
  let removedFillers = 0;
  let removedRepeats = 0;
  for (const word of heard.trim().split(/\s+/).filter(Boolean)) {
    const plain = bare(word);
    const last = kept.at(-1);
    if (plain && fillers.has(plain)) {
      removedFillers++;
      // The um took the sentence's full stop with it: give it back.
      if (last && ending(word) && !/[.!?…,;:]$/.test(last)) kept[kept.length - 1] = last + ending(word);
      continue;
    }
    if (last && plain && /\p{L}/u.test(plain) && bare(last) === plain && !MEANT.has(plain) && !ending(last)) {
      removedRepeats++;
      kept[kept.length - 1] = word;
      continue;
    }
    kept.push(word);
  }
  let text = kept
    .join(' ')
    .replace(/\s+([,.;:!?…])/g, '$1')
    .replace(/([,;:])(?:\s*[,;:])+/g, '$1')
    .replace(/^[\s,;:.]+/, '')
    .replace(/,\s*([.!?…])/g, '$1')
    .trim();
  text = text.replace(/(^|[.!?…]\s+)(\p{Ll})/gu, (_, before, letter) => before + letter.toUpperCase());
  if (/[\p{L}\p{N}]$/u.test(text)) text += '.';
  return { text, fillers: removedFillers, repeats: removedRepeats };
}

/** Words in a clip, for words a minute. */
export function wordCount(heard) {
  return heard.split(/\s+/).filter((word) => /[\p{L}\p{N}]/u.test(word)).length;
}
