/**
 * The detector, held to what it promises: it names a language only when it is
 * fairly sure, and says nothing otherwise.
 *
 * The battery is upstream Quilcast's own (`src/lang.test.ts` at `a583d50`, MIT),
 * kept as written because those are the cases the borrowed ranges and word lists
 * were tuned against, plus ours: a Castilian cast with a link and a mention, a
 * Japanese cast that is more kanji than kana, a cast that is only a link, and the
 * two helper answers the client actually branches on.
 */

import { describe, expect, it } from 'vitest';

import {
  baseLanguage,
  castTranslationSourceLanguage,
  detectCastLanguage,
} from '~/utils/castLanguage';

describe('a cast in another language is named', () => {
  const casts: [string, string][] = [
    [
      'gm farcaster! what are you all building this weekend? I just shipped a new client',
      'en',
    ],
    [
      'Hoy es un gran día para construir en Farcaster, ¿qué están haciendo ustedes?',
      'es',
    ],
    ['Eu acho que isso é muito legal, você já testou o novo cliente?', 'pt'],
    [
      "Je pense que c'est une très bonne idée pour la communauté, merci à vous",
      'fr',
    ],
    [
      'Ich habe heute ein neues Projekt gestartet und es ist wirklich toll für die Community',
      'de',
    ],
    ['今日は新しいクライアントを試してみました。とても使いやすいです！', 'ja'],
    ['今天天气很好，我们一起去公园散步吧', 'zh'],
    ['오늘 새로운 앱을 만들었어요. 다들 어떻게 생각하세요?', 'ko'],
    ['Сегодня отличный день, чтобы сделать что-нибудь новое', 'ru'],
    ['Сьогодні чудовий день, щоб зробити щось нове і цікаве', 'uk'],
    ['Hôm nay trời đẹp quá, mọi người đi chơi không?', 'vi'],
  ];

  for (const [text, language] of casts) {
    it(`names ${language}`, () => {
      expect(detectCastLanguage(text)).toBe(language);
    });
  }
});

describe('a cast it cannot place gets no answer', () => {
  for (const text of [
    'gm',
    'lol 😂😂',
    'https://quilcast.com/c/abc @dwr $DEGEN #art',
    'Farcaster Quilcast Hypersnap',
    '🔥🔥🔥 wow',
  ]) {
    it(`says nothing about ${JSON.stringify(text)}`, () => {
      expect(detectCastLanguage(text)).toBeNull();
    });
  }

  it('is not fooled by one foreign word in an English cast', () => {
    expect(
      detectCastLanguage(
        'I love the word 木漏れ日, it means sunlight through the leaves of the trees',
      ),
    ).toBe('en');
  });
});

describe('what the client branches on', () => {
  it('offers nothing for a cast in the reader’s own language', () => {
    expect(
      castTranslationSourceLanguage('gm farcaster, shipping all weekend'),
    ).toBeNull();
  });

  it('offers the language name for a cast in another one, links and tags and all', () => {
    expect(
      castTranslationSourceLanguage(
        'Hoy es un gran día para construir en Farcaster @dwr $DEGEN #art https://farcaster.xyz/dwr/0xabc',
      ),
    ).toBe('es');
  });

  it('keeps kanji-heavy Japanese Japanese, and kanji-only Chinese Chinese', () => {
    expect(detectCastLanguage('本日新発売、是非ご覧ください')).toBe('ja');
    expect(detectCastLanguage('今天天气很好，我们一起去公园散步吧')).toBe('zh');
  });

  it('takes the base of a regional code', () => {
    expect(baseLanguage('zh-Hans')).toBe('zh');
    expect(baseLanguage('pt-BR')).toBe('pt');
    expect(baseLanguage('es')).toBe('es');
  });
});
