/*
 * extract-worker.mjs — fork target for parallel feature extraction.
 *
 * Booted by extractCorpusFeatures() in corpus-eval.mjs (never imported by the
 * parent, so there are no import-time side effects). Reads its shard assignment
 * and corpus location from the environment, boots its own Praat-WASM, computes
 * the same deterministic sample, extracts records for its (index % count) slice,
 * and writes them to SHARD_OUT as JSON. No console output — the parent aggregates.
 *
 *   SHARD_INDEX / SHARD_COUNT — this worker's slice of the sample
 *   SHARD_OUT                 — path to write the records JSON
 *   TONE_PERFECT_DIR          — corpus directory
 *   TONE_PERFECT_PER_TONE     — sample size per tone ('all' = whole corpus)
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  sampleTonePerfect, resolvePerTone, analyzeClipRecord, DEFAULT_PRAAT_WASM
} from './corpus-eval.mjs';

const { createPraatWasm } = await import(DEFAULT_PRAAT_WASM);

const idx = parseInt(process.env.SHARD_INDEX, 10);
const count = parseInt(process.env.SHARD_COUNT, 10);
const dir = process.env.TONE_PERFECT_DIR;

const sample = sampleTonePerfect(dir, resolvePerTone()).filter((_, i) => i % count === idx);
const praat = await createPraatWasm();

const records = [];
for (const item of sample) records.push(analyzeClipRecord(praat, join(dir, item.file), item));

writeFileSync(process.env.SHARD_OUT, JSON.stringify(records));
