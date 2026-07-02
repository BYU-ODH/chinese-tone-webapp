/*
 * Real-recording regression / evaluation test.
 *
 * test_pipeline.mjs proves the pipeline on synthetic sinusoids; this test runs
 * it on real human recordings. There are two corpora:
 *
 *   1. old/backend/sounds/ — a small set of labeled monosyllables, several with
 *      voiced consonants (nasal /n/, lateral /l/, approximant /y/) that are the
 *      contamination case the vowel-core selection in features.js handles. These
 *      get strict, per-clip consonant-rejection checks.
 *
 *   2. tone_perfect/ — the Tone Perfect database: 410 monosyllables × 4 tones ×
 *      6 native speakers (3F, 3M) of clean studio recordings. Scored as a
 *      leave-one-speaker-out (LOSO) benchmark: each speaker is held out in turn,
 *      so the aggregate is speaker-independent and a per-speaker breakdown shows
 *      who drags which tone. The heavy machinery lives in scripts/lib/corpus-eval.mjs
 *      and is shared with the standalone benchmark, scripts/evaluate-tones.mjs.
 *
 *      Tone Perfect is licensed for research use and is NOT redistributed with
 *      this repo (gitignored). When the directory is absent this section is
 *      skipped, not failed, so the committed test stays green without the data.
 *
 *      Citation: Catherine Ryu, Mandarin Tone Perception & Production Team, and
 *      Michigan State University Libraries. Tone Perfect: Multimodal Database for
 *      Mandarin Chinese. Accessed 1 January 2019. https://tone.lib.msu.edu/
 *
 * praat-wasm.readAudio decodes MP3 directly, so no transcoding is needed. Each
 * clip is analysed with a FRESH normalizer (shape-only, "first utterance of the
 * session"), which is the most stable regime for one-off clips.
 *
 * Phase A (feature extraction) is cached to .tone-cache/ (gitignored). A
 * classifier-only change reuses the cache and re-scores in seconds; bump
 * FEATURE_CACHE_VERSION in corpus-eval.mjs after any features.js / Praat change.
 * Set TONE_CACHE=0 to force re-extraction.
 *
 * Tone accuracy is asserted as an AGGREGATE bar, not per-clip — a single off-tone
 * clip won't fail the suite, a regression in overall accuracy will. Per-tone and
 * per-speaker numbers are printed for tuning, not gated (per-fold floors are too
 * fragile). The consonant-rejection checks, by contrast, are per-clip and strict.
 *
 * Run from the project root:
 *   node test_realaudio.mjs                              # default 30/tone, serial
 *   TONE_PERFECT_PER_TONE=60 node test_realaudio.mjs     # larger / slower sample
 *   TONE_PERFECT_PER_TONE=all TONE_PERFECT_JOBS=12 node test_realaudio.mjs  # full corpus
 *
 * The full-corpus benchmark proper is `node scripts/evaluate-tones.mjs` (richer
 * per-speaker report). This test exists as a fast, gated regression check.
 */

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { createPraatWasm } from '/Users/rob/repos/praat.github.io/wasm/js/praat-wasm.mjs';
import { extractFeatures, SpeakerNormalizer } from './docs/single-word/features.js';
import { classify } from './docs/single-word/classifier.js';
import { buildAnalysisScript, parseAnalysisOutput } from './docs/single-word/praat-analysis.js';
import {
  SPEAKERS, resolvePerTone, extractCorpusFeatures, runLOSO,
  printMatrix, recall, accuracy, quiet
} from './scripts/lib/corpus-eval.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const SOUNDS = join(ROOT, 'old/backend/sounds');
const TONE_PERFECT = process.env.TONE_PERFECT_DIR || join(ROOT, 'tone_perfect');

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

/*
 * Decode one clip and run it through the full pipeline with a fresh normalizer.
 * Returns the full feature struct, or null if Praat couldn't load it or the clip
 * is judged unvoiced. Used by the old/backend section, which needs the vowel-core
 * frame counts for its consonant-rejection checks.
 */
function analyzeClip (praat, absPath) {
  const buf = readFileSync(absPath);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const sound = quiet(() => praat.readAudio(ab, '/tmp/clip.mp3'));
  if (!sound) return null;
  const analysis = parseAnalysisOutput(quiet(() => praat.run(buildAnalysisScript(sound.id))));
  quiet(() => praat.removeAll());
  const features = extractFeatures(analysis, new SpeakerNormalizer());
  return features.voiced ? features : null;
}

/* ---- old/backend/sounds: consonant rejection + small-corpus accuracy ---- */
function runSoundsCorpus (praat) {
  console.log('\n' + '='.repeat(60));
  console.log('old/backend/sounds — consonant rejection + tone accuracy');
  console.log('='.repeat(60));

  let correct = 0;
  let scored = 0;
  const consonantClips = [];

  for (const item of CORPUS) {
    const features = analyzeClip(praat, join(SOUNDS, item.file));
    const tag = `${item.hanzi} ${item.pinyin} (T${item.tone})`;
    if (!features) {
      check(false, `${tag}: clip failed to load or judged unvoiced`);
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
      check(features.vowelCoreFrames >= 6,
        `${tag}: core retains a fittable vowel (${features.vowelCoreFrames} >= 6)`);
    }
  }

  console.log('\n' + '-'.repeat(50));
  console.log(`Tone accuracy: ${correct}/${scored} clips classified correctly.`);
  console.log(`Consonant clips checked: ${consonantClips.join(', ')}`);

  // Aggregate bar = the pre-vowel-core baseline (full-span fit scored 9/15 = 60%
  // on this corpus). The vowel-core selection must never drop real accuracy
  // below what no isolation achieved; it currently reaches 11/15.
  check(correct >= Math.ceil(scored * 0.6),
    `aggregate tone accuracy ${correct}/${scored} >= 60% (pre-feature baseline)`);
}

/* ---- tone_perfect: leave-one-speaker-out benchmark ---- */
async function runTonePerfect () {
  console.log('\n' + '='.repeat(60));
  console.log('tone_perfect — leave-one-speaker-out benchmark');
  console.log('='.repeat(60));

  if (!existsSync(TONE_PERFECT)) {
    console.log(`SKIP: ${TONE_PERFECT} not present (gitignored research data).`);
    console.log('      Set TONE_PERFECT_DIR or place the corpus to enable this section.');
    return;
  }

  const perTone = resolvePerTone(30);
  const jobs = Math.max(1, parseInt(process.env.TONE_PERFECT_JOBS || '1', 10));
  const useCache = process.env.TONE_CACHE !== '0';
  console.log(`Sample: ${Number.isFinite(perTone) ? perTone + '/tone' : 'ALL clips'} · ` +
    `jobs: ${jobs} · cache: ${useCache ? 'on' : 'off'}\n`);

  const t0 = Date.now();
  const records = await extractCorpusFeatures(TONE_PERFECT, perTone, {
    jobs, useCache, log: m => console.log(`  ${m}`)
  });
  const mins = (Date.now() - t0) / 60000;

  const { aggregate, perSpeaker, scored, correct, skipped } = runLOSO(records);

  console.log(`\nScored ${scored} clips, skipped ${skipped} (load/unvoiced) in ${mins.toFixed(1)} min.`);
  console.log(`LOSO aggregate accuracy: ${correct}/${scored} = ${(100 * accuracy(aggregate).pct).toFixed(1)}%\n`);
  console.log('Confusion matrix (row = true tone, col = predicted):');
  printMatrix(aggregate);
  console.log();

  // Per-tone recall, surfaced for tuning. T3 is the current weak spot. Printed,
  // not asserted per-tone — per-tone floors are too fragile to gate a run on.
  for (const t of [1, 2, 3, 4]) {
    const r = recall(aggregate, t);
    const tot = aggregate[t][1] + aggregate[t][2] + aggregate[t][3] + aggregate[t][4];
    if (r != null) console.log(`  T${t} recall ${(100 * r).toFixed(0)}% (${aggregate[t][t]}/${tot})`);
  }

  // Per-speaker breakdown — what the LOSO split buys over a pooled matrix.
  const fmt = (S, sel) => {
    const ps = perSpeaker[S];
    if (!ps || ps.scored === 0) return `${S} -`;
    return `${S} ${sel(ps)}`;
  };
  console.log('\n  Per-speaker overall: ' +
    SPEAKERS.map(S => fmt(S, ps => (100 * ps.correct / ps.scored).toFixed(0) + '%')).join('  '));
  console.log('  Per-speaker T3 recall: ' +
    SPEAKERS.map(S => fmt(S, ps => { const r = recall(ps.conf, 3); return r == null ? '-' : (100 * r).toFixed(0) + '%'; })).join('  '));

  // Aggregate regression bar. History: the untuned classifier scored 77.3% on
  // the full corpus (T3 recall just 48%). Adding T3 fall-recover + duration cues
  // (see classifier.js / diagnose-t3.mjs) lifted the full corpus to 82.5%
  // (T3 75%, T4 76%). The 80% floor catches a real regression; the 30/tone
  // sample runs a few points higher, so the floor holds for both. Raise it (and
  // add per-tone floors) as the classifier improves further.
  check(accuracy(aggregate).pct >= 0.80,
    `tone_perfect LOSO accuracy ${(100 * accuracy(aggregate).pct).toFixed(1)}% >= 80%`);
}

async function main () {
  console.log('Booting praat-wasm…');
  const praat = await createPraatWasm();
  console.log('Ready.');

  runSoundsCorpus(praat);
  await runTonePerfect();

  console.log('\n' + '='.repeat(60));
  console.log(failures === 0 ? 'All checks passed.' : `${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(err => { console.error(err); process.exit(2); });
