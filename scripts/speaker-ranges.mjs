#!/usr/bin/env node
/*
 * speaker-ranges.mjs — recover each Tone Perfect speaker's reference range.
 *
 * The per-speaker feature cache stores coefficients in semitones re each
 * speaker's register midpoint, but not the P90−P10 range that reference was
 * built with. Range normalization (tone-match.js REFERENCE_RANGE_ST) needs it,
 * in exactly the units SpeakerNormalizer.rangeSemitones() reports live, so this
 * rebuilds pass 1 of the per-speaker extraction — identical stride, identical
 * normalizer — without re-running pass 2 over the whole corpus.
 *
 *   node scripts/speaker-ranges.mjs     # writes .tone-cache/speaker-ranges-v<N>.json
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  DEFAULT_PRAAT_WASM, FEATURE_CACHE_VERSION, sampleTonePerfect, bySpeaker,
  extractSpeakerReference
} from './lib/corpus-eval.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = process.env.TONE_PERFECT_DIR || join(ROOT, 'tone_perfect');
export const SPEAKER_RANGES_PATH =
  join(ROOT, '.tone-cache', `speaker-ranges-v${FEATURE_CACHE_VERSION}.json`);

const { createPraatWasm } = await import(DEFAULT_PRAAT_WASM);
const praat = await createPraatWasm();

const ranges = {};
for (const [speaker, items] of bySpeaker(sampleTonePerfect(DIR, Infinity))) {
  const ref = extractSpeakerReference(praat, DIR, items);
  ranges[speaker] = ref;
  console.log(`${speaker}: range ${ref.rangeSemitones.toFixed(2)} ST, mean ${ref.meanHz.toFixed(1)} Hz, ` +
    `${ref.frames} frames, trusted ${ref.trusted}`);
}

mkdirSync(dirname(SPEAKER_RANGES_PATH), { recursive: true });
writeFileSync(SPEAKER_RANGES_PATH, JSON.stringify({
  version: FEATURE_CACHE_VERSION, generatedAt: new Date().toISOString(), ranges
}, null, 2));
console.log(`wrote ${SPEAKER_RANGES_PATH}`);
