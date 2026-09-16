/*
 * Download-filename tests.
 *
 * recordingFilename() is three lines of string handling, which is exactly
 * why it gets a test: it is the only part of the download feature a reviewer
 * will not think twice about, and every one of its edge cases is silent when
 * wrong. A dropped zero-pad produces `2026916-1432.wav`, which sorts before
 * every other file in the folder and looks fine until someone tries to order
 * a session by it. A missing neutral-tone rule produces `ba4ba0`, a syllable
 * that does not exist. Neither throws, neither shows up in the UI, and both
 * end up baked into whatever corpus these recordings become.
 *
 * Run from the project root:
 *   node test_filenames.mjs
 */

import { recordingFilename } from './docs/single-word/audio.js';

let pass = 0;
let fail = 0;

function eq (label, got, want) {
  if (got === want) {
    pass++;
    console.log(`  PASS: ${label} (${got})`);
  } else {
    fail++;
    console.log(`  FAIL: ${label}\n        got  ${got}\n        want ${want}`);
  }
}

const NOON = new Date(2026, 8, 16, 14, 30, 52);   // 2026-09-16 14:30:52 local

console.log('--- pinyin ---');
eq('monosyllable, from a WORDS entry',
  recordingFilename([{ syllable: 'ma', tone: 1 }], 'orig', NOON),
  'ma1-orig-20260916-143052.wav');

eq('phrase uses surface tones, not citation (你好 is said ní hǎo)',
  recordingFilename([{ base: 'ni', tone: 2 }, { base: 'hao', tone: 3 }], 'orig', NOON),
  'ni2hao3-orig-20260916-143052.wav');

// Neutral syllables carry no digit, matching the corpus convention this
// project's own audio already uses (ba4ba, not ba4ba0).
eq('neutral tone gets no digit',
  recordingFilename([{ base: 'ba', tone: 4 }, { base: 'ba', tone: 0 }], 'orig', NOON),
  'ba4ba-orig-20260916-143052.wav');

// targets.json spells ü as v (lv, nve). A host supplying its own curriculum
// might not, and 'ü' in a filename is not portable.
eq('ü is normalized to v, as the corpus spells it',
  recordingFilename([{ base: 'lǖ', tone: 4 }], 'orig', NOON),
  'lv4-orig-20260916-143052.wav');

eq('stray diacritics and punctuation are stripped',
  recordingFilename([{ base: "Nǐ-", tone: 3 }], 'orig', NOON),
  'ni3-orig-20260916-143052.wav');

eq('no syllables still yields a usable name',
  recordingFilename([], 'orig', NOON),
  'recording-orig-20260916-143052.wav');

eq('missing syllable list does not throw',
  recordingFilename(null, 'orig', NOON),
  'recording-orig-20260916-143052.wav');

console.log('\n--- kind ---');
eq('corrected recordings are distinguishable from originals',
  recordingFilename([{ base: 'ma', tone: 1 }], 'corrected', NOON),
  'ma1-corrected-20260916-143052.wav');

console.log('\n--- timestamp ---');
// Single-digit month, day, hour, minute and second all at once: the case
// where an unpadded implementation produces 2026-1-2-3-4-5 and still "works".
eq('every field is zero-padded',
  recordingFilename([{ base: 'ma', tone: 1 }], 'orig', new Date(2026, 0, 2, 3, 4, 5)),
  'ma1-orig-20260102-030405.wav');

eq('midnight is 000000, not empty',
  recordingFilename([{ base: 'ma', tone: 1 }], 'orig', new Date(2026, 11, 31, 0, 0, 0)),
  'ma1-orig-20261231-000000.wav');

// Local time, not UTC: a learner recording at 9pm should not find the file
// dated tomorrow. Asserted by construction — the Date is built from local
// components, so a UTC-based implementation fails this wherever the machine
// is not on UTC.
const late = new Date(2026, 8, 16, 21, 0, 0);
eq('uses local calendar time, not UTC',
  recordingFilename([{ base: 'ma', tone: 1 }], 'orig', late),
  'ma1-orig-20260916-210000.wav');

// Two attempts at the same prompt in the same session must not collide —
// the reason the stamp carries seconds at all.
const a = recordingFilename([{ base: 'ma', tone: 1 }], 'orig', new Date(2026, 8, 16, 14, 30, 52));
const b = recordingFilename([{ base: 'ma', tone: 1 }], 'orig', new Date(2026, 8, 16, 14, 30, 53));
eq('consecutive attempts at one prompt get distinct names', a !== b, true);

console.log('\n--- portability ---');
const names = [
  recordingFilename([{ base: 'ni', tone: 2 }, { base: 'hao', tone: 3 }], 'orig', NOON),
  recordingFilename([{ base: 'lǖ', tone: 4 }], 'corrected', NOON),
  recordingFilename([], 'orig', NOON)
];
eq('every generated name is filesystem-safe ASCII',
  names.every(n => /^[a-z0-9-]+\.wav$/.test(n)), true);

console.log('\n' + '='.repeat(40));
console.log(fail === 0 ? 'All checks passed.' : `Result: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
