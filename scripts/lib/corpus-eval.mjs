/*
 * corpus-eval.mjs — shared evaluation machinery for the Tone Perfect corpus.
 *
 * Two phases, deliberately separated so the expensive acoustics run once and
 * classifier tuning iterates cheaply:
 *
 *   Phase A — feature extraction (expensive, cached).
 *     extractCorpusFeatures() runs the Praat + extractFeatures pipeline over a
 *     deterministic sample, in parallel forked workers, and returns one compact
 *     per-clip record. Results are cached to a gitignored file keyed by
 *     (corpus dir, sample size, FEATURE_CACHE_VERSION) so re-runs skip Praat.
 *
 *   Phase B — leave-one-speaker-out evaluation (cheap, in-memory).
 *     runLOSO() holds out each of the 6 speakers in turn, "fits" a model on the
 *     other 5, and scores the held-out speaker. Each clip is held out in exactly
 *     one fold, so the union of held-out test sets covers every clip once and the
 *     aggregate matrix is directly comparable to a pooled full-corpus run.
 *
 * The live classifier is literature-tuned (not corpus-fit), so the fitModel hook
 * is a no-op today — runLOSO's aggregate reproduces the pooled number while the
 * per-fold matrices add the per-speaker breakdown. The seam is where future
 * data-driven tuning plugs in, automatically contamination-free.
 *
 * Tone Perfect is licensed for research use and gitignored; the cache stores only
 * derived Legendre coefficients (never audio) but is corpus-derived, so it lives
 * under a gitignored path and must not be committed/redistributed.
 */

import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { fork } from 'node:child_process';

import { extractFeatures, SpeakerNormalizer } from '../../docs/single-word/features.js';
import { classify } from '../../docs/single-word/classifier.js';
import { buildAnalysisScript, parseAnalysisOutput } from '../../docs/single-word/praat-analysis.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');

/*
 * Bump whenever the acoustic pipeline changes the cached features — i.e. any edit
 * to features.js, praat-analysis.js, or the Praat script. A mismatch forces a full
 * re-extraction. (Classifier-only changes do NOT need a bump: the cache stores
 * pre-classification features, so tuning classifier.js reuses the cache and
 * re-scores in seconds — the whole point of the split.)
 */
export const FEATURE_CACHE_VERSION = 4;

export const SPEAKERS = ['FV1', 'FV2', 'FV3', 'MV1', 'MV2', 'MV3'];

// Filenames are <syllable><tone>_<speaker>_MP3.mp3, e.g. nan2_FV1_MP3.mp3.
// ü is written "v" (lv, nv, lve, nve). The tone is the digit before the speaker.
export const TP_RE = /^([a-z]+)([1-4])_([FM]V[123])_MP3\.mp3$/;

export const DEFAULT_PRAAT_WASM =
  process.env.PRAAT_WASM_DIR
    ? join(process.env.PRAAT_WASM_DIR, 'js/praat-wasm.mjs')
    : '/Users/rob/repos/praat.github.io/wasm/js/praat-wasm.mjs';

/* ---------------------------------------------------------------- sampling */

/*
 * Deterministically pick `perTone` clips for each tone, evenly strided through
 * the alphabetically-sorted list. Because the list groups by syllable then
 * speaker, striding spreads the sample across many syllables and all six
 * speakers without any randomness — same machine, same sample, every run.
 * perTone === Infinity selects the whole corpus.
 */
export function sampleTonePerfect (dir, perTone) {
  const byTone = { 1: [], 2: [], 3: [], 4: [] };
  for (const f of readdirSync(dir)) {
    const m = TP_RE.exec(f);
    if (m) byTone[+m[2]].push({ file: f, syllable: m[1], speaker: m[3], tone: +m[2] });
  }
  const sample = [];
  for (const t of [1, 2, 3, 4]) {
    const group = byTone[t].sort((a, b) => (a.file < b.file ? -1 : 1));
    if (!Number.isFinite(perTone)) { sample.push(...group); continue; }
    const n = Math.min(perTone, group.length);
    const stride = Math.max(1, Math.floor(group.length / n));
    for (let i = 0, k = 0; k < n && i < group.length; i += stride, k++) sample.push(group[i]);
  }
  return sample;
}

// Resolve the per-tone sample size from the environment (shared parent/worker).
// `dflt` lets callers pick the default: the regression test wants 30, the
// standalone benchmark wants the whole corpus ('all').
export function resolvePerTone (dflt = 30) {
  const env = process.env.TONE_PERFECT_PER_TONE;
  if (env == null) return dflt === 'all' ? Infinity : dflt;
  return env === 'all' ? Infinity : Math.max(1, parseInt(env, 10));
}

/* --------------------------------------------------- single-clip analysis */

/* praat-wasm echoes the Info window to stdout and offers no way to disable it;
 * silence stdout around the Praat calls so output stays readable. */
export function quiet (fn) {
  const w = process.stdout.write.bind(process.stdout);
  process.stdout.write = () => true;
  try { return fn(); } finally { process.stdout.write = w; }
}

/*
 * Decode one clip and run it through the full pipeline with a fresh normalizer
 * (shape-only, "first utterance of the session" — the regime that produces the
 * baseline numbers). Returns a compact, JSON-serialisable record carrying both
 * the clip labels and the fields the classifier consumes. A record is always
 * returned: load failures and unvoiced clips come back with voiced:false so the
 * evaluator can count them as skipped rather than losing them.
 */
export function analyzeClipRecord (praat, absPath, item) {
  const label = { syllable: item.syllable, tone: item.tone, speaker: item.speaker };
  const buf = readFileSync(absPath);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const sound = quiet(() => praat.readAudio(ab, '/tmp/clip.mp3'));
  if (!sound) return { ...label, voiced: false, reason: 'load-failed' };

  const analysis = parseAnalysisOutput(quiet(() => praat.run(buildAnalysisScript(sound.id))));
  quiet(() => praat.removeAll());
  const f = extractFeatures(analysis, new SpeakerNormalizer());

  if (!f.voiced) return { ...label, voiced: false, reason: f.reason };
  return {
    ...label,
    voiced: true,
    registerTrusted: f.registerTrusted,
    coefs: f.coefs,
    onset: f.onset,
    offset: f.offset,
    vowelCoreFrames: f.vowelCoreFrames,
    voicedFrameCount: f.voicedFrameCount
  };
}

/* ------------------------------------------------- feature extraction (A) */

function cachePath (dir, perTone) {
  const tag = Number.isFinite(perTone) ? String(perTone) : 'all';
  return join(ROOT, '.tone-cache', `features-${tag}-v${FEATURE_CACHE_VERSION}.json`);
}

/*
 * Extract (or load from cache) one record per clip in the deterministic sample.
 *   dir      — corpus directory
 *   perTone  — sample size per tone (Infinity = whole corpus)
 *   jobs     — forked workers (>1 fans out; 1 runs in-process)
 *   useCache — read/write the on-disk cache (default true)
 * `log` is an optional progress callback (message => void).
 */
export async function extractCorpusFeatures (dir, perTone, { jobs = 1, useCache = true, log = () => {} } = {}) {
  const path = cachePath(dir, perTone);
  if (useCache && existsSync(path)) {
    const cached = JSON.parse(readFileSync(path, 'utf8'));
    log(`cache hit: ${cached.records.length} records (v${FEATURE_CACHE_VERSION}) from ${path}`);
    return cached.records;
  }

  const sample = sampleTonePerfect(dir, perTone);
  log(`extracting features for ${sample.length} clips` + (jobs > 1 ? ` across ${jobs} workers…` : '…'));
  const records = jobs > 1
    ? await extractParallel(dir, perTone, jobs, log)
    : await extractSerial(dir, sample, log);

  if (useCache) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({
      version: FEATURE_CACHE_VERSION, dir, perTone: Number.isFinite(perTone) ? perTone : 'all',
      generatedAt: new Date().toISOString(), records
    }));
    log(`cached ${records.length} records to ${path}`);
  }
  return records;
}

async function extractSerial (dir, sample, log) {
  const { createPraatWasm } = await import(DEFAULT_PRAAT_WASM);
  const praat = await createPraatWasm();
  const records = [];
  for (const item of sample) records.push(analyzeClipRecord(praat, join(dir, item.file), item));
  log(`extracted ${records.length} records (serial)`);
  return records;
}

// Fan the deterministic sample out across `jobs` forked workers. Each worker
// computes the same sample, takes its (index % jobs) slice, and writes its
// records to a temp file; the parent concatenates them.
async function extractParallel (dir, perTone, jobs, log) {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const worker = join(__dirname, 'extract-worker.mjs');
  const outDir = mkdtempSync(join(tmpdir(), 'tp-feat-'));
  let done = 0;

  const runs = Array.from({ length: jobs }, (_, i) => {
    const out = join(outDir, `shard-${i}.json`);
    const child = fork(worker, [], {
      env: {
        ...process.env,
        SHARD_INDEX: String(i), SHARD_COUNT: String(jobs), SHARD_OUT: out,
        TONE_PERFECT_DIR: dir,
        TONE_PERFECT_PER_TONE: Number.isFinite(perTone) ? String(perTone) : 'all'
      },
      // Discard worker stdout (Praat echoes its Info window); keep stderr for crashes.
      stdio: ['ignore', 'ignore', 'inherit', 'ipc']
    });
    return new Promise((resolve, reject) => {
      child.on('exit', (code) => {
        if (code !== 0) return reject(new Error(`extract worker ${i} exited with code ${code}`));
        log(`  worker ${++done}/${jobs} finished`);
        resolve(JSON.parse(readFileSync(out, 'utf8')));
      });
      child.on('error', reject);
    });
  });

  const parts = await Promise.all(runs);
  return parts.flat();
}

/* ----------------------------------------------- confusion-matrix helpers */

// conf[trueTone][predictedTone], all zero.
export function emptyConf () {
  return { 1: { 1: 0, 2: 0, 3: 0, 4: 0 }, 2: { 1: 0, 2: 0, 3: 0, 4: 0 },
           3: { 1: 0, 2: 0, 3: 0, 4: 0 }, 4: { 1: 0, 2: 0, 3: 0, 4: 0 } };
}

export function addToConf (conf, trueTone, predTone) {
  conf[trueTone][predTone]++;
}

// Per-tone recall as a fraction (0..1), or null when the tone is unseen.
export function recall (conf, t) {
  const r = conf[t];
  const tot = r[1] + r[2] + r[3] + r[4];
  return tot ? r[t] / tot : null;
}

// Overall accuracy (diagonal / total) of a confusion matrix.
export function accuracy (conf) {
  let correct = 0, total = 0;
  for (const t of [1, 2, 3, 4]) {
    correct += conf[t][t];
    for (const c of [1, 2, 3, 4]) total += conf[t][c];
  }
  return { correct, total, pct: total ? correct / total : 0 };
}

// Print a labelled confusion matrix with a per-tone recall column.
export function printMatrix (conf) {
  console.log('        T1    T2    T3    T4   | recall');
  for (const t of [1, 2, 3, 4]) {
    const r = conf[t];
    const rc = recall(conf, t);
    console.log(`   T${t} ${String(r[1]).padStart(5)} ${String(r[2]).padStart(5)} ` +
      `${String(r[3]).padStart(5)} ${String(r[4]).padStart(5)}   | ` +
      `${rc == null ? '-' : (100 * rc).toFixed(0) + '%'}`);
  }
}

/* ----------------------------------------------------- LOSO evaluation (B) */

/*
 * The fitModel seam. Given the training-speaker records, return a scoring
 * function (target, features) => verdict. The current classifier is
 * literature-tuned, so training data is ignored — but the signature is the hook
 * future data-driven tuning fills in, and runLOSO guarantees the training set
 * never includes the held-out speaker.
 */
export function fitStatic (/* trainRecords */) {
  return (target, features) => classify(target, features);
}

/*
 * Leave-one-speaker-out evaluation. For each speaker, fit on the other five and
 * score the held-out speaker's clips. Returns the aggregate confusion matrix
 * (every clip scored once), a per-speaker breakdown, and overall tallies.
 * Unvoiced / load-failed records are counted as skipped, never scored — mirroring
 * the old harness.
 */
export function runLOSO (records, fitModel = fitStatic) {
  const aggregate = emptyConf();
  const perSpeaker = {};
  let scored = 0, correct = 0, skipped = 0;

  for (const S of SPEAKERS) {
    const train = records.filter(r => r.speaker !== S);
    const test = records.filter(r => r.speaker === S);
    const model = fitModel(train);

    const conf = emptyConf();
    let sScored = 0, sCorrect = 0, sSkipped = 0;
    for (const r of test) {
      if (!r.voiced) { sSkipped++; continue; }
      const v = model(r.tone, r);
      addToConf(conf, r.tone, v.bestTone);
      addToConf(aggregate, r.tone, v.bestTone);
      sScored++;
      if (v.bestTone === r.tone) sCorrect++;
    }
    perSpeaker[S] = { conf, scored: sScored, correct: sCorrect, skipped: sSkipped };
    scored += sScored; correct += sCorrect; skipped += sSkipped;
  }

  return { aggregate, perSpeaker, scored, correct, skipped };
}
