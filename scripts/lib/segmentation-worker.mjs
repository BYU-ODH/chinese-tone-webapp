/*
 * segmentation-worker.mjs — fork target for parallel segmentation
 * validation. Mirrors toneaudio-worker.mjs's shape. Booted by
 * extractSegmentationResults() in segmentation-eval.mjs; never imported
 * by the parent.
 *
 *   SHARD_INDEX / SHARD_COUNT — this worker's slice of the manifest
 *   SHARD_OUT                 — path to write the records JSON
 *   TONEAUDIO_DIR              — corpus directory
 */
import { writeFileSync } from 'node:fs';

import { buildManifest, applyStride } from './toneaudio-eval.mjs';
import { analyzeSegmentationClip } from './segmentation-eval.mjs';
import { DEFAULT_PRAAT_WASM } from './corpus-eval.mjs';

const { createPraatWasm } = await import(DEFAULT_PRAAT_WASM);

const idx = parseInt(process.env.SHARD_INDEX, 10);
const count = parseInt(process.env.SHARD_COUNT, 10);
const dir = process.env.TONEAUDIO_DIR;

const items = applyStride(buildManifest(dir)).filter(m => m.cat !== 'single').filter((_, i) => i % count === idx);
const praat = await createPraatWasm();

const records = items.map(item => analyzeSegmentationClip(praat, item));
writeFileSync(process.env.SHARD_OUT, JSON.stringify(records));
