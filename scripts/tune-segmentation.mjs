/*
 * tune-segmentation.mjs — sweep segmentSyllables()'s thresholds against
 * real double-syllable ToneAudio clips, measuring PER-SYLLABLE TONE
 * ACCURACY (not just the peaks% proxy) so a threshold change that inflates
 * peaks% without finding genuinely correct boundaries doesn't look like a
 * win. Praat extraction is cached once (segmentation-tune.mjs); each
 * combination in the sweep is pure JS re-analysis of the cached contours.
 *
 * Two accuracy numbers matter per combo:
 *   - overall: per-syllable accuracy using THIS combo's actual mixed
 *     peaks/even-split segmentation, on every eligible clip.
 *   - baseline: per-syllable accuracy if every clip used even-split
 *     unconditionally (no peak-detection at all) — computed once,
 *     constant across the sweep. The overall-minus-baseline delta is
 *     whether peak-detection is adding value, or just adding false
 *     confidence to no-better-than-baseline boundaries.
 *
 * Usage:
 *   node scripts/tune-segmentation.mjs
 *   SEG_JOBS=14 node scripts/tune-segmentation.mjs   # first run: parallel extraction
 *   SEG_TUNE_CACHE=0 node scripts/tune-segmentation.mjs   # force re-extraction
 */
import { prepUtterance, extractSyllableFeatures, SpeakerNormalizer } from '../docs/single-word/features.js';
import { segmentSyllables } from '../docs/single-word/segmentation.js';
import { classify } from '../docs/single-word/classifier.js';
import { resolveToneAudioDir } from './lib/toneaudio-eval.mjs';
import { loadOrExtract } from './lib/segmentation-tune.mjs';

function mean (xs) { return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null; }
function pct (n, d) { return d ? +(100 * n / d).toFixed(1) : null; }
function fmtPct (p) { return p == null ? '-' : `${p}%`; }

/** Run one threshold combo against every voiced cached record. */
function evaluateCombo (records, opts) {
  let peaksClips = 0, evenSplitClips = 0;
  let peaksCorrect = 0, peaksTotal = 0;
  let evenSplitCorrect = 0, evenSplitTotal = 0;

  for (const rec of records) {
    if (!rec.voiced) continue;
    const prep = prepUtterance(rec.analysis);
    if (!prep.rawSpan) continue;

    const { spans, method } = segmentSyllables(rec.analysis.intensity, rec.analysis.pitch, 2, prep.rawSpan, opts);
    const norm = new SpeakerNormalizer();
    let clipCorrect = 0, clipTotal = 0;
    spans.forEach((span, i) => {
      const f = extractSyllableFeatures(prep, span, norm);
      if (!f.voiced) return;
      const v = classify(rec.targetTones[i], f);
      clipTotal++;
      if (v.bestTone === rec.targetTones[i]) clipCorrect++;
    });

    if (method === 'peaks') { peaksClips++; peaksCorrect += clipCorrect; peaksTotal += clipTotal; }
    else { evenSplitClips++; evenSplitCorrect += clipCorrect; evenSplitTotal += clipTotal; }
  }

  const totalClips = peaksClips + evenSplitClips;
  return {
    peaksClips, evenSplitClips, peaksPct: pct(peaksClips, totalClips),
    peaksAccuracy: pct(peaksCorrect, peaksTotal),
    evenSplitAccuracy: pct(evenSplitCorrect, evenSplitTotal),
    overallAccuracy: pct(peaksCorrect + evenSplitCorrect, peaksTotal + evenSplitTotal)
  };
}

async function main () {
  const dir = resolveToneAudioDir(process.env.TONEAUDIO_DIR);
  if (!dir) { console.error('No ToneAudio_* corpus directory found.'); process.exit(1); }
  const jobs = parseInt(process.env.SEG_JOBS || '1', 10);
  const useCache = process.env.SEG_TUNE_CACHE !== '0';

  console.log('='.repeat(78));
  console.log('Segmentation threshold sweep — real double-syllable ToneAudio clips');
  console.log('='.repeat(78));

  const records = await loadOrExtract(dir, { jobs, useCache, log: console.log });
  const voicedCount = records.filter(r => r.voiced).length;
  console.log(`${voicedCount}/${records.length} clips voiced\n`);

  // Baseline: force even-split unconditionally (minProminenceDb=Infinity
  // guarantees peaks.length < targetCount for every clip), through the
  // EXACT same extract/classify path as every other combo.
  const baseline = evaluateCombo(records, { minProminenceDb: Infinity });
  console.log(`Baseline (always even-split): accuracy ${fmtPct(baseline.evenSplitAccuracy)} ` +
    `(${baseline.evenSplitClips} clips)\n`);

  const prominenceGrid = [2, 3, 4, 5, 6, 8, 10, 14];
  const smoothGrid = [0.015, 0.03, 0.05];

  const rows = [];
  for (const smoothWindowSec of smoothGrid) {
    for (const minProminenceDb of prominenceGrid) {
      const r = evaluateCombo(records, { minProminenceDb, smoothWindowSec });
      rows.push({ minProminenceDb, smoothWindowSec, ...r });
    }
  }

  console.log('smooth(ms)  minProm(dB)  peaks%   peaksAcc   evenSplitAcc   overallAcc   delta-vs-baseline');
  for (const r of rows) {
    const delta = r.overallAccuracy == null || baseline.evenSplitAccuracy == null
      ? '-' : `${(r.overallAccuracy - baseline.evenSplitAccuracy).toFixed(1)}pp`;
    console.log(
      `${String(r.smoothWindowSec * 1000).padStart(9)}  ${String(r.minProminenceDb).padStart(10)}  ` +
      `${fmtPct(r.peaksPct).padStart(6)}  ${fmtPct(r.peaksAccuracy).padStart(9)}  ` +
      `${fmtPct(r.evenSplitAccuracy).padStart(12)}  ${fmtPct(r.overallAccuracy).padStart(10)}  ${delta.padStart(8)}`
    );
  }

  const best = [...rows].filter(r => r.overallAccuracy != null)
    .sort((a, b) => b.overallAccuracy - a.overallAccuracy)[0];
  console.log(`\nBest overall accuracy: smoothWindowSec=${best.smoothWindowSec} minProminenceDb=${best.minProminenceDb} ` +
    `→ ${fmtPct(best.overallAccuracy)} (peaks% ${fmtPct(best.peaksPct)}, baseline ${fmtPct(baseline.evenSplitAccuracy)})`);
}

main().catch(err => { console.error(err); process.exit(2); });
