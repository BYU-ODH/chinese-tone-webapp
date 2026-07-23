/*
 * segmentation-tune-worker.mjs — fork target for parallel raw-analysis
 * extraction. Mirrors toneaudio-worker.mjs's shape. Booted by
 * loadOrExtract() in segmentation-tune.mjs; never imported by the parent.
 *
 *   SHARD_INDEX / SHARD_COUNT — this worker's slice of the eligible items
 *   SHARD_OUT                 — path to write the records JSON
 *   TONEAUDIO_DIR              — corpus directory
 */
import { writeFileSync } from 'node:fs';

import { eligibleDoubleItems, extractAnalysisRecord } from './segmentation-tune.mjs';
import { DEFAULT_PRAAT_WASM } from './corpus-eval.mjs';

const { createPraatWasm } = await import(DEFAULT_PRAAT_WASM);

const idx = parseInt(process.env.SHARD_INDEX, 10);
const count = parseInt(process.env.SHARD_COUNT, 10);
const dir = process.env.TONEAUDIO_DIR;

const items = eligibleDoubleItems(dir).filter((_, i) => i % count === idx);
const praat = await createPraatWasm();

const records = items.map(item => extractAnalysisRecord(praat, item));
writeFileSync(process.env.SHARD_OUT, JSON.stringify(records));
