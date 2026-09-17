/*
 * extract-worker.mjs — fork target for parallel feature extraction.
 *
 * Booted by extractCorpusFeatures() in corpus-eval.mjs (never imported by the
 * parent, so there are no import-time side effects). Reads its shard assignment
 * and corpus location from the environment, boots its own Praat-WASM, computes
 * the same deterministic sample, extracts its slice, and writes the records to
 * SHARD_OUT as JSON. No console output — the parent aggregates.
 *
 *   SHARD_OUT                 — path to write the records JSON
 *   TONE_PERFECT_DIR          — corpus directory
 *   TONE_PERFECT_PER_TONE     — sample size per tone ('all' = whole corpus)
 *   NORMALIZATION             — 'per-clip' (default) or 'per-speaker'
 *
 * Which shard variable applies depends on the regime, because the two split the
 * work differently (see extractParallel):
 *   per-clip     SHARD_INDEX / SHARD_COUNT — this worker's (index % count) slice
 *   per-speaker  SHARD_SPEAKERS — comma-separated speaker codes owned whole, so
 *                a speaker's reference is built from all of that speaker's clips
 *                in one process
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  sampleTonePerfect, resolvePerTone, analyzeClipRecord, extractSpeakerRecords,
  bySpeaker, DEFAULT_PRAAT_WASM
} from './corpus-eval.mjs';

const { createPraatWasm } = await import(DEFAULT_PRAAT_WASM);

const dir = process.env.TONE_PERFECT_DIR;
const normalization = process.env.NORMALIZATION || 'per-clip';
const sample = sampleTonePerfect(dir, resolvePerTone());
const praat = await createPraatWasm();

const records = [];
if (normalization === 'per-speaker') {
  const mine = new Set((process.env.SHARD_SPEAKERS || '').split(',').filter(Boolean));
  for (const [speaker, items] of bySpeaker(sample)) {
    if (!mine.has(speaker)) continue;
    records.push(...extractSpeakerRecords(praat, dir, items).records);
  }
} else {
  const idx = parseInt(process.env.SHARD_INDEX, 10);
  const count = parseInt(process.env.SHARD_COUNT, 10);
  for (const item of sample.filter((_, i) => i % count === idx)) {
    records.push(analyzeClipRecord(praat, join(dir, item.file), item));
  }
}

writeFileSync(process.env.SHARD_OUT, JSON.stringify(records));
