/*
 * Calibration/practice word list, shared by app.js and audio-ab-test.js.
 *
 * WORDS[0..3] are exactly ma1/ma2/ma3/ma4 — the calibration set walked by
 * app.js's bootCalibration flow (one utterance per tone, by construction).
 * `syllable` is the base pinyin without the tone diacritic — the lookup
 * key into Tone Perfect-derived target data (see targets.js).
 */
export const WORDS = [
  { hanzi: '妈', pinyin: 'mā', tone: 1, gloss: 'mother', syllable: 'ma' },
  { hanzi: '麻', pinyin: 'má', tone: 2, gloss: 'hemp',   syllable: 'ma' },
  { hanzi: '马', pinyin: 'mǎ', tone: 3, gloss: 'horse',  syllable: 'ma' },
  { hanzi: '骂', pinyin: 'mà', tone: 4, gloss: 'scold',  syllable: 'ma' },
  { hanzi: '八', pinyin: 'bā', tone: 1, gloss: 'eight',  syllable: 'ba' },
  { hanzi: '拿', pinyin: 'ná', tone: 2, gloss: 'take',   syllable: 'na' },
  { hanzi: '你', pinyin: 'nǐ', tone: 3, gloss: 'you',    syllable: 'ni' },
  { hanzi: '不', pinyin: 'bù', tone: 4, gloss: 'not',    syllable: 'bu' }
];

/**
 * The calibration set: one word per tone, same base syllable, so a completed
 * pass satisfies SpeakerNormalizer's tone-diversity gate by construction.
 * Selected BY TONE rather than by slicing WORDS[0..3], so reordering or
 * inserting into WORDS above can't silently change what calibration asks for.
 * Shared by both apps via calibration.js.
 */
export const CALIBRATION_WORDS = [1, 2, 3, 4].map(
  tone => WORDS.find(w => w.syllable === 'ma' && w.tone === tone)
);
