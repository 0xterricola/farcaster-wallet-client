/**
 * Which language a cast is in, cheaply and in the browser.
 *
 * By its script for anything that is not the Latin alphabet, by its most common
 * short words for the languages that are. It answers only when it is fairly
 * sure — a cast it cannot place returns `null` and simply gets no Translate
 * control — so a wrong guess never becomes a wrong translation offered.
 *
 * Borrowed from Quilcast (MIT, Copyright (c) 2026 Nikita Kolmogorov) at commit
 * `a583d50` ("0.26.0: free translations of casts in other languages"), where it
 * is `src/lang.ts`: a few KB of ranges and word lists instead of a classifier
 * like Laya. Reimplemented here in TypeScript with the names this repo uses.
 */

/** One language's own words: short, common, and a word may count for several languages. */
const COMMON_WORDS: Record<string, string> = {
  en: 'the and is are to of in that it you for on with this was have be not but what just so my your we they i',
  es: 'el la los las que de y en es por para con una un del pero muy esto también como más lo se no',
  pt: 'o os as que de e em é um uma para com não mais muito isso você eu está são do da no na',
  fr: 'le la les et est des une un pour pas que qui dans avec sur je vous ce cette mais très du au',
  de: 'der die das und ist nicht ein eine ich du mit auf für den dem sich auch wir sie es zu von',
  it: 'il lo la gli che di e è un una per non con sono questo ma molto anche più del della',
  nl: 'de het een en is van dat niet ik je met voor op zijn maar ook wat er naar',
  tr: 've bir bu da de için ne çok ile gibi ama ben sen var yok daha mi',
  id: 'dan yang di ini itu tidak ada aku saya kamu untuk dengan ke dari juga bisa',
  pl: 'i w na nie że to jest się z do jak co ale mnie tak jestem',
  sv: 'och att det är som en på för med inte jag har av till',
};

const WORD_SETS: [string, Set<string>][] = Object.entries(COMMON_WORDS).map(
  ([language, words]) => [language, new Set(words.split(' '))],
);

/**
 * Scripts that name one language (or the one most people write in it), in the
 * order they are checked: the first script a character belongs to wins, so the
 * narrower alphabets come before Latin.
 */
const SCRIPTS: [RegExp, string][] = [
  [/[\u3040-\u30ff]/, 'ja'],
  [/[\uac00-\ud7af\u1100-\u11ff\u3130-\u318f]/, 'ko'],
  [/[\u3400-\u9fff\uf900-\ufaff]/, 'zh'],
  [/[\u0400-\u04ff]/, 'cyr'],
  [/[\u0600-\u06ff\u0750-\u077f]/, 'arab'],
  [/[\u0590-\u05ff]/, 'he'],
  [/[\u0e00-\u0e7f]/, 'th'],
  [/[\u0900-\u097f]/, 'hi'],
  [/[\u0980-\u09ff]/, 'bn'],
  [/[\u0b80-\u0bff]/, 'ta'],
  [/[\u0370-\u03ff]/, 'el'],
  [/[\u10a0-\u10ff]/, 'ka'],
  [/[\u0530-\u058f]/, 'hy'],
  [/[a-z\u00c0-\u024f\u1e00-\u1eff]/i, 'latin'],
];

/** Letters only Vietnamese has (â, ê and ô belong to Portuguese and French too). */
const VIETNAMESE_LETTERS =
  /[ăđơưạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹ]/i;

/** Ukrainian has і, ї, є and ґ, and Russian does not. */
const UKRAINIAN_LETTERS = /[іїєґ]/i;

/** Persian has پ, چ, ژ and گ, and standard Arabic does not. */
const PERSIAN_LETTERS = /[پچژگ]/;

/** Fewer letters than this is not evidence of anything (an emoji, a ticker, "gm"). */
const ENOUGH_LETTERS = 6;

/** The cast's language as an ISO 639-1 code ('zh' for any Chinese), or null when it is not clear. */
const detectCastLanguage = (text: string): string | null => {
  if (typeof text !== 'string' || !text) {
    return null;
  }

  // Links, mentions, tickers and tags say nothing about the language.
  const cleaned = text.replace(/https?:\/\/\S+|[@$#/][\w.-]+/g, ' ');
  const tally = new Map<string, number>();
  let letters = 0;

  for (const character of cleaned) {
    if (!/\p{L}/u.test(character)) {
      continue;
    }
    letters += 1;
    const script = SCRIPTS.find(([pattern]) => pattern.test(character))?.[1];
    if (script) {
      tally.set(script, (tally.get(script) || 0) + 1);
    }
  }

  if (letters < ENOUGH_LETTERS) {
    return null;
  }

  const [top, hits] = [...tally].sort((a, b) => b[1] - a[1])[0] || ['', 0];
  // Half the letters: a cast in two scripts is not a cast in one language.
  if (hits < letters / 2) {
    return null;
  }

  // Japanese mixes in Chinese characters; any kana at all makes it Japanese.
  if (top === 'zh' && tally.get('ja')) {
    return 'ja';
  }
  if (top === 'cyr') {
    return UKRAINIAN_LETTERS.test(cleaned) ? 'uk' : 'ru';
  }
  if (top === 'arab') {
    return PERSIAN_LETTERS.test(cleaned) ? 'fa' : 'ar';
  }
  if (top !== 'latin') {
    return top;
  }

  if (VIETNAMESE_LETTERS.test(cleaned)) {
    return 'vi';
  }

  const words = cleaned.toLowerCase().match(/\p{L}+/gu) || [];
  const scores = WORD_SETS.map(
    ([language, set]) =>
      [language, words.filter((word) => set.has(word)).length] as const,
  ).sort((a, b) => b[1] - a[1]);
  const [[best, bestHits], [, runnerUp]] = scores;

  // Two separate words, and clearly ahead of the runner-up: one word in common
  // with a language is a coincidence, not an answer.
  return bestHits >= 2 && bestHits > runnerUp * 1.5 ? best : null;
};

/** What the client reads its own UI in: the language a cast is translated INTO. */
const CLIENT_LANGUAGE = 'en';

/** The base of an ISO code ('pt-BR' → 'pt'), as this detector names languages. */
const baseLanguage = (code: string) => code.split('-')[0];

/**
 * The language to offer a translation FROM, or null when there is nothing to offer.
 *
 * Null for a cast in the reader's own language, and null for one the detector
 * cannot place: in both cases the reader gets no control, which is the honest
 * answer and what upstream's `Said` does too.
 */
const castTranslationSourceLanguage = (text: string): string | null => {
  const language = detectCastLanguage(text);
  return language && baseLanguage(language) !== CLIENT_LANGUAGE
    ? language
    : null;
};

export {
  baseLanguage,
  castTranslationSourceLanguage,
  CLIENT_LANGUAGE,
  detectCastLanguage,
};
