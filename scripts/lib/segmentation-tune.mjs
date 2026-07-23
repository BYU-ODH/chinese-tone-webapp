/*
 * segmentation-tune.mjs — cache raw Praat analyses for a clean subset of
 * real double-syllable ToneAudio clips, so scripts/tune-segmentation.mjs
 * can sweep segmentSyllables()'s thresholds cheaply (pure JS, no Praat)
 * against real per-syllable tone accuracy instead of re-extracting audio
 * for every combination tried.
 *
 * "Clean subset" = double-category tokens with exactly 2 tone digits in
 * the filename (toneDigits(token).length === 2) — both syllables citation-
 * tone-clear, no neutral-tone digit-omission ambiguity to resolve first.
 * Target tones are CITATION tones (sandhi not applied) — a constant bias
 * across every threshold combo, so it doesn't affect the relative
 * comparison this sweep is for, only the absolute accuracy numbers.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { fork } from 'node:child_process';

import { buildAnalysisScript, parseAnalysisOutput } from '../../docs/single-word/praat-analysis.js';
import { DEFAULT_PRAAT_WASM, quiet } from './corpus-eval.mjs';
import { buildManifest, applyStride } from './toneaudio-eval.mjs';
import { toneDigits } from './pinyin-segment.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
// Stride-keyed: a TONEAUDIO_STRIDE smoke-test run must never share a cache
// file with (and silently poison) the full run's, or vice versa.
const stride = Math.max(1, parseInt(process.env.TONEAUDIO_STRIDE || '1', 10));
export const CACHE_PATH = join(ROOT, '.tone-cache', `segmentation-tune-double-stride${stride}.json`);

export function eligibleDoubleItems (dir) {
  return applyStride(buildManifest(dir))
    .filter(m => m.cat === 'double' && toneDigits(m.token).length === 2);
}

/** Analyze one clip down to its raw Praat analysis struct + target tones. No feature extraction here — that's cheap and happens per sweep iteration instead. */
export function extractAnalysisRecord (praat, item) {
  const rec = { token: item.token, speaker: item.speaker, condition: item.condition, targetTones: toneDigits(item.token) };
  try {
    const buf = readFileSync(item.path);
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    const sound = quiet(() => praat.readAudio(ab, '/tmp/clip.mp3'));
    if (!sound) return { ...rec, voiced: false };
    const analysis = parseAnalysisOutput(quiet(() => praat.run(buildAnalysisScript(sound.id))));
    quiet(() => praat.removeAll());
    return { ...rec, voiced: true, analysis };
  } catch {
    quiet(() => { try { praat.removeAll(); } catch { /* ignore */ } });
    return { ...rec, voiced: false };
  }
}

async function extractSerial (items, log) {
  const { createPraatWasm } = await import(DEFAULT_PRAAT_WASM);
  const praat = await createPraatWasm();
  const records = items.map(item => extractAnalysisRecord(praat, item));
  log(`extracted ${records.length} records (serial)`);
  return records;
}

async function extractParallel (dir, jobs, log) {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const worker = join(__dirname, 'segmentation-tune-worker.mjs');
  const outDir = mkdtempSync(join(tmpdir(), 'seg-tune-'));
  let done = 0;

  const runs = Array.from({ length: jobs }, (_, i) => {
    const out = join(outDir, `shard-${i}.json`);
    const child = fork(worker, [], {
      env: { ...process.env, SHARD_INDEX: String(i), SHARD_COUNT: String(jobs), SHARD_OUT: out, TONEAUDIO_DIR: dir },
      stdio: ['ignore', 'ignore', 'inherit', 'ipc']
    });
    return new Promise((resolve, reject) => {
      child.on('exit', (code) => {
        if (code !== 0) return reject(new Error(`segmentation-tune worker ${i} exited with code ${code}`));
        log(`  worker ${++done}/${jobs} finished`);
        resolve(JSON.parse(readFileSync(out, 'utf8')));
      });
      child.on('error', reject);
    });
  });

  return (await Promise.all(runs)).flat();
}

/** Load from disk cache if present, else extract (optionally parallel) and cache. */
export async function loadOrExtract (dir, { jobs = 1, useCache = true, log = () => {} } = {}) {
  if (useCache && existsSync(CACHE_PATH)) {
    const cached = JSON.parse(readFileSync(CACHE_PATH, 'utf8'));
    log(`cache hit: ${cached.records.length} records from ${CACHE_PATH}`);
    return cached.records;
  }
  const items = eligibleDoubleItems(dir);
  log(`${items.length} eligible double-syllable clips (both syllables citation-tone-clear)`);
  const records = jobs > 1 ? await extractParallel(dir, jobs, log) : await extractSerial(items, log);
  if (useCache) {
    mkdirSync(dirname(CACHE_PATH), { recursive: true });
    writeFileSync(CACHE_PATH, JSON.stringify({ generatedAt: new Date().toISOString(), dir, records }));
    log(`cached ${records.length} records to ${CACHE_PATH}`);
  }
  return records;
}
