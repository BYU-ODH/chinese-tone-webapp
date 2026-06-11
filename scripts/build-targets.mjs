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
 *         "1": { coefs: [c0,c1,c2,c3], sd: [s0,s1,s2,s3], n: 6 },
 *         "2": { ... }, ...
 *       },
 *       ...
 *     }
 *   }
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

const __dirname = dirname(fileURLToPath(import.meta.url));
const PRAAT_DIR = process.env.PRAAT_WASM_DIR
  || resolve(__dirname, '../../praat.github.io/wasm');

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
      speaker: m[3].toUpperCase()
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

function buildAnalysisScript (soundId) {
  // Same script the live engine uses. Inlined because praat-engine.js is
  // browser-only (relies on createPraatWorker / Blob URLs).
  return `
writeInfoLine: "BEGIN"
selectObject: ${soundId}
duration = Get total duration
sr = Get sampling frequency
appendInfoLine: "DURATION ", fixed$(duration, 6)
appendInfoLine: "SAMPLERATE ", fixed$(sr, 1)
selectObject: ${soundId}
To Pitch (ac): 0.005, 75, 15, "no", 0.01, 0.30, 0.01, 0.35, 0.14, 600
pitchId = selected("Pitch")
nFrames = Get number of frames
dx = Get time step
x1 = Get time from frame number: 1
appendInfoLine: "PITCH"
appendInfoLine: "n ", nFrames
appendInfoLine: "dx ", fixed$(dx, 6)
appendInfoLine: "x1 ", fixed$(x1, 6)
appendInfoLine: "values"
for i to nFrames
    f = Get value in frame: i, "Hertz"
    if f = undefined
        appendInfoLine: "u"
    else
        appendInfoLine: fixed$(f, 3)
    endif
endfor
appendInfoLine: "endvalues"
removeObject: pitchId
selectObject: ${soundId}
To Intensity: 75, 0.005, "yes"
intensityId = selected("Intensity")
nIntFrames = Get number of frames
intDx = Get time step
intX1 = Get time from frame number: 1
appendInfoLine: "INTENSITY"
appendInfoLine: "n ", nIntFrames
appendInfoLine: "dx ", fixed$(intDx, 6)
appendInfoLine: "x1 ", fixed$(intX1, 6)
appendInfoLine: "values"
for i to nIntFrames
    v = Get value in frame: i
    if v = undefined
        appendInfoLine: "u"
    else
        appendInfoLine: fixed$(v, 3)
    endif
endfor
appendInfoLine: "endvalues"
removeObject: intensityId
selectObject: ${soundId}
To Harmonicity (cc): 0.01, 75, 0.1, 1.0
hnrId = selected("Harmonicity")
hnrMean = Get mean: 0, 0
if hnrMean = undefined
    appendInfoLine: "HNR_MEAN -99"
else
    appendInfoLine: "HNR_MEAN ", fixed$(hnrMean, 3)
endif
removeObject: hnrId
selectObject: ${soundId}
To PointProcess (periodic, cc): 75, 600
ppId = selected("PointProcess")
nPeriods = Get number of periods: 0, 0, 0.0001, 0.02, 1.3
if nPeriods >= 2
    jitter = Get jitter (local): 0, 0, 0.0001, 0.02, 1.3
    if jitter = undefined
        appendInfoLine: "JITTER -1"
    else
        appendInfoLine: "JITTER ", fixed$(jitter, 6)
    endif
else
    appendInfoLine: "JITTER -1"
endif
removeObject: ppId
appendInfoLine: "END"
`;
}

function parseAnalysisOutput (text) {
  const lines = text.split('\n').map(l => l.trim());
  const out = {
    duration: 0, sampleRate: 0,
    pitch: { n: 0, dx: 0, x1: 0, values: [] },
    intensity: { n: 0, dx: 0, x1: 0, values: [] },
    hnrMean: -99, jitter: -1
  };
  let mode = null, inValues = false, block = null;
  for (const line of lines) {
    if (!line || line === 'BEGIN' || line === 'END') continue;
    if (line === 'PITCH') { mode = 'PITCH'; block = out.pitch; continue; }
    if (line === 'INTENSITY') { mode = 'INTENSITY'; block = out.intensity; continue; }
    if (line === 'values') { inValues = true; continue; }
    if (line === 'endvalues') { inValues = false; mode = null; block = null; continue; }
    if (inValues && block) {
      block.values.push(line === 'u' || line === '--undefined--' ? NaN : parseFloat(line));
      continue;
    }
    const sp = line.indexOf(' ');
    if (sp < 0) continue;
    const key = line.slice(0, sp);
    const num = parseFloat(line.slice(sp + 1).trim());
    if (mode === 'PITCH' || mode === 'INTENSITY') {
      if (key === 'n') block.n = num | 0;
      else if (key === 'dx') block.dx = num;
      else if (key === 'x1') block.x1 = num;
      continue;
    }
    if (key === 'DURATION') out.duration = num;
    else if (key === 'SAMPLERATE') out.sampleRate = num;
    else if (key === 'HNR_MEAN') out.hnrMean = num;
    else if (key === 'JITTER') out.jitter = num;
  }
  return out;
}

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
  const sound = praat.readAudio(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '/tmp/in');
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
    hnrMean: analysis.hnrMean,
    jitter: analysis.jitter,
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
    { pitch: ff.pitch, intensity: ff.intensity, hnrMean: ff.hnrMean, jitter: ff.jitter, duration: ff.duration },
    norm
  );
  if (!feats.voiced) continue;
  const key = `${ff.syllable}|${ff.tone}`;
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(feats.coefs);
}

/* ---------- Aggregation ---------- */

const syllables = {};
for (const [key, runs] of groups) {
  const [syllable, toneStr] = key.split('|');
  const tone = parseInt(toneStr, 10);
  if (runs.length === 0) continue;

  const coefs = [0, 0, 0, 0];
  for (const r of runs) for (let k = 0; k < 4; k++) coefs[k] += r[k];
  for (let k = 0; k < 4; k++) coefs[k] /= runs.length;

  const sd = [0, 0, 0, 0];
  if (runs.length > 1) {
    for (const r of runs) for (let k = 0; k < 4; k++) sd[k] += (r[k] - coefs[k]) ** 2;
    for (let k = 0; k < 4; k++) sd[k] = Math.sqrt(sd[k] / (runs.length - 1));
  }

  if (!syllables[syllable]) syllables[syllable] = {};
  syllables[syllable][tone] = {
    coefs: coefs.map(v => Number(v.toFixed(4))),
    sd: sd.map(v => Number(v.toFixed(4))),
    n: runs.length
  };
}

const out = {
  version: 'tone-perfect-v1',
  generatedAt: new Date().toISOString(),
  speakers: [...speakerNormalizers.keys()].sort(),
  syllables
};

writeFileSync(outputPath, JSON.stringify(out, null, 2));
console.error(`Wrote ${outputPath}`);
console.error(`  ${Object.keys(syllables).length} syllables × up to 4 tones`);
