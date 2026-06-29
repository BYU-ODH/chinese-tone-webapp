/*
 * Real-recording regression test.
 *
 * test_pipeline.mjs proves the pipeline on synthetic sinusoids; this test runs
 * it on real human recordings from old/backend/sounds/ — short monosyllables
 * with known tones, several with voiced consonants (nasal /n/, lateral /l/,
 * approximant /y/) that are exactly the contamination case the vowel-core
 * selection in features.js was built to handle.
 *
 * praat-wasm.readAudio decodes MP3 directly, so no transcoding is needed. Each
 * clip is classified with a FRESH normalizer (shape-only, "first utterance of
 * the session"), which is the most stable regime for one-off clips.
 *
 * The classifier thresholds are still being tuned against real voices (see the
 * header of classifier.js), so tone accuracy is asserted as an AGGREGATE bar,
 * not per-clip — a single off-tone clip won't fail the suite, a regression in
 * overall accuracy will. The consonant-rejection checks, by contrast, are
 * per-clip and strict: that is the behavior this work is responsible for.
 *
 * Run from the project root (after building/serving is not required):
 *   node test_realaudio.mjs
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { createPraatWasm } from '/Users/rob/repos/praat.github.io/wasm/js/praat-wasm.mjs';
import { extractFeatures, SpeakerNormalizer } from './docs/single-word/features.js';
import { classify } from './docs/single-word/classifier.js';
import { buildAnalysisScript, parseAnalysisOutput } from './docs/single-word/praat-analysis.js';

const ROOT = dirname(fileURLToPath(import.meta.url));
const SOUNDS = join(ROOT, 'old/backend/sounds');

/*
 * Labeled monosyllables drawn from old/backend/sounds/. tone is the citation
 * tone of the pinyin. voicedOnset/voicedCoda flag syllables whose initial or
 * final is a voiced consonant (nasal/lateral/approximant) that carries F0 and
 * would contaminate the tone contour if not excluded from the vowel core.
 */
const CORPUS = [
  { file: '1/1.mp3',   hanzi: '八', pinyin: 'bā',   tone: 1 },
  { file: '1/2.mp3',   hanzi: '男', pinyin: 'nán',  tone: 2, voicedOnset: true, voicedCoda: true },
  { file: '1/3.mp3',   hanzi: '女', pinyin: 'nǚ',   tone: 3, voicedOnset: true },
  { file: '1/4.mp3',   hanzi: '二', pinyin: 'èr',   tone: 4 },
  { file: '3/2.mp3',   hanzi: '谁', pinyin: 'shéi', tone: 2 },
  { file: '3/4.mp3',   hanzi: '叫', pinyin: 'jiào', tone: 4 },
  { file: '5/1.mp3',   hanzi: '说', pinyin: 'shuō', tone: 1 },
  { file: '5/2.mp3',   hanzi: '能', pinyin: 'néng', tone: 2, voicedOnset: true, voicedCoda: true },
  { file: '5/3.mp3',   hanzi: '海', pinyin: 'hǎi',  tone: 3 },
  { file: '5/4.mp3',   hanzi: '更', pinyin: 'gèng', tone: 4, voicedCoda: true },
  { file: '7/1.mp3',   hanzi: '花', pinyin: 'huā',  tone: 1 },
  { file: '7/2.mp3',   hanzi: '鱼', pinyin: 'yú',   tone: 2, voicedOnset: true },
  { file: '7/3.mp3',   hanzi: '狗', pinyin: 'gǒu',  tone: 3 },
  { file: '7/4.mp3',   hanzi: '路', pinyin: 'lù',   tone: 4, voicedOnset: true },
  { file: 'pre/1.mp3', hanzi: '都', pinyin: 'dōu',  tone: 1 }
];

let failures = 0;
function check (cond, label) {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}: ${label}`);
  if (!cond) failures++;
}

/* praat-wasm echoes the Info window to stdout and offers no way to disable it;
 * silence stdout around the Praat calls so the test output stays readable. */
function quiet (fn) {
  const w = process.stdout.write.bind(process.stdout);
  process.stdout.write = () => true;
  try { return fn(); } finally { process.stdout.write = w; }
}

async function main () {
  console.log('Booting praat-wasm…');
  const praat = await createPraatWasm();
  console.log('Ready.\n');

  let correct = 0;
  let scored = 0;
  const consonantClips = [];

  for (const item of CORPUS) {
    const buf = readFileSync(join(SOUNDS, item.file));
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);

    const sound = quiet(() => praat.readAudio(ab, `/tmp/${item.hanzi}.mp3`));
    if (!sound) { check(false, `${item.pinyin}: readAudio returned null`); continue; }
    const analysis = parseAnalysisOutput(quiet(() => praat.run(buildAnalysisScript(sound.id))));
    quiet(() => praat.removeAll());

    const features = extractFeatures(analysis, new SpeakerNormalizer());
    const tag = `${item.hanzi} ${item.pinyin} (T${item.tone})`;

    if (!features.voiced) {
      check(false, `${tag}: extractFeatures voiced=false (reason=${features.reason})`);
      continue;
    }

    const verdict = classify(item.tone, features);
    scored++;
    if (verdict.bestTone === item.tone) correct++;

    const coreRatio = (features.vowelCoreFrames / features.voicedFrameCount);
    console.log(
      `${tag.padEnd(16)} core ${String(features.vowelCoreFrames).padStart(3)}/` +
      `${String(features.voicedFrameCount).padEnd(3)} (${(coreRatio * 100).toFixed(0)}%)  ` +
      `c=[${features.coefs.map(c => c.toFixed(1).padStart(5)).join(',')}]  ` +
      `best=T${verdict.bestTone} ${verdict.verdict}`
    );

    // Consonant-rejection contract (per-clip, strict): for a syllable with a
    // voiced consonant flanking the vowel, the vowel core MUST be a proper
    // subset of the voiced span — some consonant frames were trimmed.
    if (item.voicedOnset || item.voicedCoda) {
      consonantClips.push(item.pinyin);
      check(features.vowelCoreFrames < features.voicedFrameCount,
        `${tag}: voiced consonant trimmed from core ` +
        `(${features.vowelCoreFrames} < ${features.voicedFrameCount})`);
      // The core must still retain enough of the vowel to fit.
      check(features.vowelCoreFrames >= 6,
        `${tag}: core retains a fittable vowel (${features.vowelCoreFrames} >= 6)`);
    }
  }

  console.log('\n' + '-'.repeat(50));
  console.log(`Tone accuracy: ${correct}/${scored} clips classified correctly.`);
  console.log(`Consonant clips checked: ${consonantClips.join(', ')}`);

  // Aggregate accuracy bar = the pre-vowel-core baseline (full-span fit scored
  // 9/15 = 60% on this corpus). The vowel-core selection must never drop real
  // accuracy below what no isolation achieved; it currently reaches 11/15. The
  // remaining misses are all T2→T3 confusions (the rises ARE captured — c1 is
  // positive — but the classifier's T2/T3 discrimination is still being tuned),
  // which is a classifier concern, not a vowel-isolation one. Tighten as tuned.
  check(correct >= Math.ceil(scored * 0.6),
    `aggregate tone accuracy ${correct}/${scored} >= 60% (pre-feature baseline)`);

  console.log('\n' + '='.repeat(50));
  console.log(failures === 0 ? 'All checks passed.' : `${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(err => { console.error(err); process.exit(2); });
