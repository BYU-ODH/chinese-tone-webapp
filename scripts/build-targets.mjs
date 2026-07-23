#!/usr/bin/env node
/*
 * build-targets.mjs — ingest Tone Perfect (MSU) into per-syllable Legendre
 * targets for the tone trainer.
 *
 * Usage:
 *   node scripts/build-targets.mjs <tone-perfect-dir> [output.json]
 *
 *   <tone-perfect-dir> is a directory containing Tone Perfect audio files
 *   in their distributed naming convention. Either a flat directory or
 *   nested by speaker is fine — we recurse and match by filename pattern.
 *
 * Tone Perfect filename convention:
 *   <syllable><tone>_<speakerCode>_MP3.mp3
 *   e.g.,  ma1_FV1_MP3.mp3,  shi3_MV2_MP3.mp3
 *   speakerCode ∈ {FV1, FV2, FV3, MV1, MV2, MV3}.
 *   `.wav` variants are also accepted.
 *
 * Per file we run the same Praat analysis the live app uses (pitch_ac
 * with the child-friendly parameters), trim leading/trailing unvoiced,
 * convert to semitones-re-speaker-mean (one mean per speaker computed
 * across all of that speaker's files), bridge short voicing dropouts,
 * and fit Legendre orders 0..3.
 *
 * Output:  targets.json (drop into docs/single-word/) — schema:
 *   {
 *     version: "tone-perfect-v1",
 *     generatedAt: ISO timestamp,
 *     speakers: [...],
 *     syllables: {
 *       "ma": {
 *         "1": { coefs: [c0,c1,c2,c3], sd: [s0,s1,s2,s3], offset, dur, n: 6 },
 *         "2": { ... }, ...
 *       },
 *       ...
 *     }
 *   }
 *
 *   offset = mean end-height (semitones re speaker mean); dur = mean voiced-frame
 *   count (~5 ms/frame). Both are carried because the classifier now keys on them
 *   (T3 fall-recover, T4 shortness), so the target band can reflect the full
 *   acceptance region, not just the Legendre shape.
 *
 * License note: Tone Perfect is distributed by Michigan State University
 * with terms restricting redistribution. This script writes only derived
 * Legendre coefficients (means + SDs) — not audio — which is conventionally
 * considered transformative. Verify with the corpus license owner before
 * deploying targets.json publicly.
 *
 * Requires praat-wasm to be available. By default we pull it from the
 * sibling repo at ../praat.github.io/wasm; override via PRAAT_WASM_DIR.
 */

import { readdirSync, statSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve, relative, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

import { extractFeatures, SpeakerNormalizer, legendreFit } from '../docs/single-word/features.js';
import { buildAnalysisScript, parseAnalysisOutput } from '../docs/single-word/praat-analysis.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Matches the sibling checkout used by the LOSO harness (corpus-eval.mjs).
const PRAAT_DIR = process.env.PRAAT_WASM_DIR || '/Users/rob/repos/praat.github.io/wasm';

/* ---------- CLI ---------- */

const [, , inputDir, outputArg] = process.argv;
if (!inputDir) {
  console.error('Usage: node scripts/build-targets.mjs <tone-perfect-dir> [output.json]');
  process.exit(2);
}
const outputPath = outputArg || resolve(__dirname, '../docs/single-word/targets.json');

/* ---------- File discovery ---------- */

const FILE_RE = /^([a-z]{1,7})([1-5])_([FM]V[123])_MP3\.(mp3|wav|aiff)$/i;

function walk (dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

const files = walk(resolve(inputDir))
  .map(p => {
    const m = basename(p).match(FILE_RE);
    if (!m) return null;
    return {
      path: p,
      syllable: m[1].toLowerCase(),
      tone: parseInt(m[2], 10),
      speaker: m[3].toUpperCase(),
      ext: m[4].toLowerCase()
    };
  })
  .filter(Boolean);

if (files.length === 0) {
  console.error(`No Tone Perfect files found under ${inputDir}.`);
  console.error(`Expected names like "ma1_FV1_MP3.mp3".`);
  process.exit(1);
}

console.error(`Found ${files.length} files.`);

/* ---------- Praat boot ---------- */

const { createPraatWasm } = await import(join(PRAAT_DIR, 'js/praat-wasm.mjs'));
const praat = await createPraatWasm();
console.error('praat-wasm ready.');

// buildAnalysisScript / parseAnalysisOutput are imported from the shared
// praat-analysis.js (the single source of truth used by the live engine, the
// LOSO harness, and the tests) so targets.json is built with the EXACT same
// pitch/intensity/per-frame-harmonicity analysis the classifier sees at runtime.

/* ---------- Two-pass over the corpus ---------- */

/*
 * Pass 1: per-speaker normalizer baseline.
 *   For each speaker, accumulate voicedHz across all of that speaker's
 *   files. The mean of that pool is used as the per-speaker semitone
 *   reference for that speaker's productions in pass 2. This way a male
 *   speaker's T1 and a female speaker's T1 land on the same semitone
 *   scale before averaging.
 *
 * Pass 2: feature extraction & Legendre fit per file, accumulated by
 *   (syllable, tone). Compute mean and SD across files at the end.
 */

const speakerNormalizers = new Map();   // speakerCode -> SpeakerNormalizer
const fileFeatures = [];                // { syllable, tone, speaker, coefs }

console.error('Pass 1/2: computing per-speaker references…');
let processed = 0;
for (const f of files) {
  processed++;
  if (processed % 50 === 0) {
    process.stderr.write(`  ${processed}/${files.length}\r`);
  }
  const bytes = readFileSync(f.path);
  // Preserve the extension: praat-wasm picks its decoder from the filename.
  const sound = praat.readAudio(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), `/tmp/in.${f.ext}`);
  if (!sound) { praat.removeAll(); continue; }

  const text = praat.run(buildAnalysisScript(sound.id));
  const analysis = parseAnalysisOutput(text);
  praat.removeAll();

  // For pass 1 we only need a temporary normalizer to extract voicedHz.
  const tmp = new SpeakerNormalizer();
  const feats = extractFeatures(analysis, tmp);
  if (!feats.voiced) continue;

  let n = speakerNormalizers.get(f.speaker);
  if (!n) { n = new SpeakerNormalizer(); speakerNormalizers.set(f.speaker, n); }
  // Use referenceFrames (the cleaned subset) for the speaker baseline.
  n.add(feats.referenceFrames);

  // Stash for pass 2 (re-extract features below with the real normalizer).
  fileFeatures.push({
    syllable: f.syllable,
    tone: f.tone,
    speaker: f.speaker,
    pitch: analysis.pitch,
    intensity: analysis.intensity,
    harmonicity: analysis.harmonicity,
    hnrMean: analysis.hnrMean,
    duration: analysis.duration
  });
}
process.stderr.write(`\n`);

console.error(`Pass 1 done. Speakers: ${[...speakerNormalizers.keys()].sort().join(', ')}.`);
for (const [code, n] of speakerNormalizers) {
  console.error(`  ${code}: ${n.count} frames, range ${n.rangeSemitones().toFixed(1)} ST, mean ${n.meanHz()?.toFixed(1)} Hz`);
}

console.error('Pass 2/2: fitting Legendre per file…');
const groups = new Map();   // `${syllable}|${tone}` -> array of coef arrays

for (const ff of fileFeatures) {
  const norm = speakerNormalizers.get(ff.speaker);
  if (!norm) continue;
  // Provide a normalizer the extractFeatures pipeline will see as trusted.
  const feats = extractFeatures(
    { pitch: ff.pitch, intensity: ff.intensity, harmonicity: ff.harmonicity,
      hnrMean: ff.hnrMean, duration: ff.duration },
    norm
  );
  if (!feats.voiced) continue;
  const key = `${ff.syllable}|${ff.tone}`;
  if (!groups.has(key)) groups.set(key, []);
  // Carry the non-shape features the classifier now keys on (offset, duration)
  // alongside the Legendre coefs so the target band reflects the full acceptance.
  groups.get(key).push({ coefs: feats.coefs, offset: feats.offset, dur: feats.voicedFrameCount });
}

/* ---------- Aggregation ---------- */

const syllables = {};
for (const [key, runs] of groups) {
  const [syllable, toneStr] = key.split('|');
  const tone = parseInt(toneStr, 10);
  if (runs.length === 0) continue;

  const coefs = [0, 0, 0, 0];
  for (const r of runs) for (let k = 0; k < 4; k++) coefs[k] += r.coefs[k];
  for (let k = 0; k < 4; k++) coefs[k] /= runs.length;

  const sd = [0, 0, 0, 0];
  if (runs.length > 1) {
    for (const r of runs) for (let k = 0; k < 4; k++) sd[k] += (r.coefs[k] - coefs[k]) ** 2;
    for (let k = 0; k < 4; k++) sd[k] = Math.sqrt(sd[k] / (runs.length - 1));
  }

  const mean = sel => runs.reduce((s, r) => s + sel(r), 0) / runs.length;

  if (!syllables[syllable]) syllables[syllable] = {};
  syllables[syllable][tone] = {
    coefs: coefs.map(v => Number(v.toFixed(4))),
    sd: sd.map(v => Number(v.toFixed(4))),
    offset: Number(mean(r => r.offset).toFixed(4)),   // mean end-height (semitones re speaker mean)
    dur: Math.round(mean(r => r.dur)),                // mean voiced-frame count (~5 ms/frame)
    n: runs.length
  };
}

const out = {
  version: 'tone-perfect-v2',
  generatedAt: new Date().toISOString(),
  speakers: [...speakerNormalizers.keys()].sort(),
  syllables
};

writeFileSync(outputPath, JSON.stringify(out, null, 2));
console.error(`Wrote ${outputPath}`);
console.error(`  ${Object.keys(syllables).length} syllables × up to 4 tones`);
