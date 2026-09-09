/*
 * Phrase curriculum for the multi-syllable trainer.
 *
 * `surfaceTones` is STORED, not computed at runtime. sandhi.js is an
 * authoring-time tool by design (see its file header): resolveSandhi() runs
 * once per entry, a human reviews the output, and the reviewed result is
 * committed here. test_phrases.mjs re-runs resolveSandhi() over every entry
 * and fails if a stored array has drifted from what the rules produce — so
 * the data stays honest without the app ever depending on a live guess.
 *
 * Scope rules this list deliberately obeys:
 *
 *   - No phrase contains three or more consecutive citation-T3 syllables.
 *     resolveSandhi() flags those as a genuine prosodic-domain ambiguity
 *     (Shih 1986) and refuses to guess; the correct grouping for the one
 *     real example we have ("wo3 ye3 hen3 ...") is an open question with
 *     our Chinese collaborators. Until it is answered, shipping such a
 *     phrase would mean drilling learners against a guess. The test
 *     asserts resolveSandhi() returns zero flags for everything here.
 *
 *   - Neutral-tone syllables (`tone: 0`) are included, because they are
 *     unavoidable in real speech, but they are NOT scored — see
 *     classifier.js's tone-0 guard. They render grey and are excluded from
 *     the phrase's aggregate result.
 *
 * Field notes:
 *   pinyin         citation form, with diacritic (what the word "is")
 *   surfacePinyin  only when sandhi changes it (what the learner should SAY)
 *   base           tone-stripped syllable; the lookup key into targets.json
 *   tone           citation tone, 1-4, or 0 for neutral
 *   morph          'bu' | 'yi' | 'redup' where sandhi depends on lexical
 *                  identity rather than on adjacent tones alone
 */

export const PHRASES = [
  {
    id: 'ni-hao',
    hanzi: '你好',
    gloss: 'hello',
    note: 'T3 + T3: the first syllable is said as a rising tone.',
    syllables: [
      { pinyin: 'nǐ', surfacePinyin: 'ní', base: 'ni', tone: 3 },
      { pinyin: 'hǎo', base: 'hao', tone: 3 }
    ],
    surfaceTones: [2, 3]
  },
  {
    id: 'hen-hao',
    hanzi: '很好',
    gloss: 'very good',
    note: 'T3 + T3, same rule as 你好.',
    syllables: [
      { pinyin: 'hěn', surfacePinyin: 'hén', base: 'hen', tone: 3 },
      { pinyin: 'hǎo', base: 'hao', tone: 3 }
    ],
    surfaceTones: [2, 3]
  },
  {
    id: 'lao-shi',
    hanzi: '老师',
    gloss: 'teacher',
    syllables: [
      { pinyin: 'lǎo', base: 'lao', tone: 3 },
      { pinyin: 'shī', base: 'shi', tone: 1 }
    ],
    surfaceTones: [3, 1]
  },
  {
    id: 'zhong-guo',
    hanzi: '中国',
    gloss: 'China',
    syllables: [
      { pinyin: 'zhōng', base: 'zhong', tone: 1 },
      { pinyin: 'guó', base: 'guo', tone: 2 }
    ],
    surfaceTones: [1, 2]
  },
  {
    id: 'qing-wen',
    hanzi: '请问',
    gloss: 'excuse me / may I ask',
    syllables: [
      { pinyin: 'qǐng', base: 'qing', tone: 3 },
      { pinyin: 'wèn', base: 'wen', tone: 4 }
    ],
    surfaceTones: [3, 4]
  },
  {
    id: 'bu-dui',
    hanzi: '不对',
    gloss: "that's not right",
    note: '不 rises to a T2 before a T4.',
    syllables: [
      { pinyin: 'bù', surfacePinyin: 'bú', base: 'bu', tone: 4, morph: 'bu' },
      { pinyin: 'duì', base: 'dui', tone: 4 }
    ],
    surfaceTones: [2, 4]
  },
  {
    id: 'bu-hao',
    hanzi: '不好',
    gloss: 'not good',
    note: '不 keeps its T4 here — the next tone is not a T4.',
    syllables: [
      { pinyin: 'bù', base: 'bu', tone: 4, morph: 'bu' },
      { pinyin: 'hǎo', base: 'hao', tone: 3 }
    ],
    surfaceTones: [4, 3]
  },
  {
    id: 'yi-ge',
    hanzi: '一个',
    gloss: 'one (of something)',
    note: '一 rises to a T2 before a T4.',
    syllables: [
      { pinyin: 'yī', surfacePinyin: 'yí', base: 'yi', tone: 1, morph: 'yi' },
      { pinyin: 'gè', base: 'ge', tone: 4 }
    ],
    surfaceTones: [2, 4]
  },
  {
    id: 'xie-xie',
    hanzi: '谢谢',
    gloss: 'thank you',
    note: 'The second syllable is neutral — light and short, not scored.',
    syllables: [
      { pinyin: 'xiè', base: 'xie', tone: 4 },
      { pinyin: 'xie', base: 'xie', tone: 0 }
    ],
    surfaceTones: [4, 0]
  },
  {
    id: 'ma-ma',
    hanzi: '妈妈',
    gloss: 'mum',
    note: 'The second syllable is neutral — light and short, not scored.',
    syllables: [
      { pinyin: 'mā', base: 'ma', tone: 1 },
      { pinyin: 'ma', base: 'ma', tone: 0 }
    ],
    surfaceTones: [1, 0]
  },
  {
    id: 'xie-xie-ni',
    hanzi: '谢谢你',
    gloss: 'thank you (to you)',
    note: 'Three syllables, with a neutral in the middle.',
    syllables: [
      { pinyin: 'xiè', base: 'xie', tone: 4 },
      { pinyin: 'xie', base: 'xie', tone: 0 },
      { pinyin: 'nǐ', base: 'ni', tone: 3 }
    ],
    surfaceTones: [4, 0, 3]
  },
  {
    id: 'zhong-guo-lao-shi',
    hanzi: '中国老师',
    gloss: 'Chinese teacher',
    note: 'Four syllables — the longest phrase in this set.',
    syllables: [
      { pinyin: 'zhōng', base: 'zhong', tone: 1 },
      { pinyin: 'guó', base: 'guo', tone: 2 },
      { pinyin: 'lǎo', base: 'lao', tone: 3 },
      { pinyin: 'shī', base: 'shi', tone: 1 }
    ],
    surfaceTones: [1, 2, 3, 1]
  }
];

/** Citation tones, in order — what the phrase "is", before sandhi. */
export function citationTones (phrase) {
  return phrase.syllables.map(s => s.tone);
}

/**
 * What the learner should actually say for syllable i: the surface pinyin
 * when sandhi changed it, otherwise the citation form.
 */
export function spokenPinyin (phrase, i) {
  const s = phrase.syllables[i];
  return s.surfacePinyin || s.pinyin;
}

/** True when sandhi moved this syllable off its dictionary tone. */
export function isSandhi (phrase, i) {
  return phrase.surfaceTones[i] !== phrase.syllables[i].tone;
}
