#!/usr/bin/env node
/*
 * evaluate-tones.mjs — the publishable leave-one-speaker-out (LOSO) benchmark
 * for the Mandarin tone classifier on the Tone Perfect corpus.
 *
 * No published speaker-independent benchmark exists on Tone Perfect; the
 * comparable speaker-independent bar elsewhere is ~95.5% (Chen et al. 2016).
 * This script holds out each of the 6 native speakers (3F, 3M) in turn, scores
 * the held-out speaker, and reports the aggregate plus a per-speaker breakdown so
 * cross-speaker variance (and any male/female register asymmetry) is visible.
 *
 * Phase A (feature extraction) is cached to .tone-cache/ (gitignored): the first
 * full-corpus run is ~28 min across 12 workers; subsequent runs — including after
 * a classifier-only edit — hit the cache and finish in seconds. Bump
 * FEATURE_CACHE_VERSION in corpus-eval.mjs after any features.js / Praat change.
 *
 *   node scripts/evaluate-tones.mjs                                  # full corpus, serial
 *   TONE_PERFECT_JOBS=12 node scripts/evaluate-tones.mjs             # full corpus, parallel
 *   TONE_PERFECT_PER_TONE=60 node scripts/evaluate-tones.mjs         # quick strided sample
 *   TONE_CACHE=0 TONE_PERFECT_JOBS=12 node scripts/evaluate-tones.mjs # force re-extraction
 *
 * Tone Perfect (Catherine Ryu, Mandarin Tone Perception & Production Team, and
 * Michigan State University Libraries; https://tone.lib.msu.edu/) is licensed for
 * research use and is NOT redistributed with this repo (gitignored).
 */

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  SPEAKERS, resolvePerTone, extractCorpusFeatures, runLOSO,
  printMatrix, recall, accuracy
} from './lib/corpus-eval.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = process.env.TONE_PERFECT_DIR || join(ROOT, 'tone_perfect');

async function main () {
  if (!existsSync(DIR)) {
    console.error(`Corpus not found at ${DIR}.`);
    console.error('Set TONE_PERFECT_DIR or place the gitignored Tone Perfect corpus there.');
    process.exit(1);
  }

  const perTone = resolvePerTone('all');
  const jobs = Math.max(1, parseInt(process.env.TONE_PERFECT_JOBS || '1', 10));
  const useCache = process.env.TONE_CACHE !== '0';

  console.log('='.repeat(64));
  console.log('Tone Perfect — leave-one-speaker-out (LOSO) benchmark');
  console.log('='.repeat(64));
  console.log(`Sample: ${Number.isFinite(perTone) ? perTone + '/tone' : 'ALL clips'} · ` +
    `jobs: ${jobs} · cache: ${useCache ? 'on' : 'off'}`);

  const t0 = Date.now();
  const records = await extractCorpusFeatures(DIR, perTone, {
    jobs, useCache, log: m => console.log(`  ${m}`)
  });
  const extractMin = (Date.now() - t0) / 60000;
  console.log(`Phase A (features) done in ${extractMin.toFixed(1)} min.\n`);

  const { aggregate, perSpeaker, scored, correct, skipped } = runLOSO(records);

  // --- Aggregate (union of held-out folds = every clip scored once) ---
  const agg = accuracy(aggregate);
  console.log('-'.repeat(64));
  console.log(`LOSO aggregate — ${scored} scored, ${skipped} skipped (load/unvoiced)`);
  console.log(`Overall accuracy: ${correct}/${scored} = ${(100 * agg.pct).toFixed(1)}%\n`);
  console.log('Confusion matrix (row = true tone, col = predicted):');
  printMatrix(aggregate);
  console.log();
  for (const t of [1, 2, 3, 4]) {
    const r = recall(aggregate, t);
    if (r != null) console.log(`  T${t} recall ${(100 * r).toFixed(0)}%`);
  }

  // --- Per-speaker breakdown (each row = that speaker held out) ---
  console.log('\n' + '-'.repeat(64));
  console.log('Per-speaker (held-out) accuracy and recall:');
  console.log('  spk     overall    T1    T2    T3    T4    (n)');
  const overalls = [], t3s = [];
  for (const S of SPEAKERS) {
    const ps = perSpeaker[S];
    if (!ps || ps.scored === 0) { console.log(`  ${S}      —  (no clips)`); continue; }
    const o = ps.correct / ps.scored;
    overalls.push(o);
    const cells = [1, 2, 3, 4].map(t => {
      const r = recall(ps.conf, t);
      if (t === 3 && r != null) t3s.push(r);
      return r == null ? '   -' : (100 * r).toFixed(0).padStart(3) + '%';
    });
    console.log(`  ${S}     ${(100 * o).toFixed(1).padStart(5)}%  ` +
      `${cells.join('  ')}   (${ps.scored})`);
  }

  if (overalls.length > 1) {
    const meanRange = arr => {
      const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
      return { mean, min: Math.min(...arr), max: Math.max(...arr) };
    };
    const o = meanRange(overalls), t3 = meanRange(t3s);
    console.log('\n  cross-speaker overall: ' +
      `mean ${(100 * o.mean).toFixed(1)}%  range ${(100 * o.min).toFixed(1)}–${(100 * o.max).toFixed(1)}%`);
    if (t3s.length) console.log('  cross-speaker T3 recall: ' +
      `mean ${(100 * t3.mean).toFixed(0)}%  range ${(100 * t3.min).toFixed(0)}–${(100 * t3.max).toFixed(0)}%`);
  }

  // Sanity: every scored clip belongs to exactly one held-out fold.
  const foldSum = SPEAKERS.reduce((s, S) => s + (perSpeaker[S]?.scored || 0), 0);
  console.log(`\n  (sanity: per-fold scored ${foldSum} == aggregate scored ${scored} == matrix total ${agg.total})`);
}

main().catch(err => { console.error(err); process.exit(2); });
