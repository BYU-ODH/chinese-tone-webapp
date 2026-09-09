/*
 * tune-segmentation-guided.mjs — measures segmentSyllablesGuided() (the
 * known-target-tone-guided DP alignment, docs/single-word/segmentation.js)
 * against the SAME 1,027 real double-syllable ToneAudio clips that sank
 * segmentSyllables()'s blind intensity-peak approach (see
 * scripts/tune-segmentation.mjs and segmentation.js's file header for that
 * negative result). Reuses the exact same cache (segmentation-tune.mjs) so
 * all three numbers below are directly comparable:
 *   - baseline:  always even-split, no segmentation logic at all
 *   - peaks:     segmentSyllables() at its best-found tuning
 *                (smoothWindowSec=0.05, minProminenceDb=10 — see
 *                segmentation-history.json's "threshold sweep" entry)
 *   - guided:    segmentSyllablesGuided()
 *
 * Usage:
 *   node scripts/tune-segmentation-guided.mjs
 *   SEG_JOBS=14 node scripts/tune-segmentation-guided.mjs   # first run: parallel extraction
 */
import { prepUtterance, extractSyllableFeatures, SpeakerNormalizer } from '../docs/single-word/features.js';
import { segmentSyllables, segmentSyllablesGuided } from '../docs/single-word/segmentation.js';
import { classify } from '../docs/single-word/classifier.js';
import { resolveToneAudioDir } from './lib/toneaudio-eval.mjs';
import { loadOrExtract } from './lib/segmentation-tune.mjs';
import { gitInfo } from './lib/bench-log.mjs';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HISTORY_PATH = join(__dirname, 'results', 'segmentation-history.json');

function pct (n, d) { return d ? +(100 * n / d).toFixed(1) : null; }
function fmtPct (p) { return p == null ? '-' : `${p}%`; }

function scoreSpans (prep, spans, targetTones) {
  const norm = new SpeakerNormalizer();
  let correct = 0, total = 0;
  spans.forEach((span, i) => {
    const f = extractSyllableFeatures(prep, span, norm);
    if (!f.voiced) return;
    total++;
    if (classify(targetTones[i], f).bestTone === targetTones[i]) correct++;
  });
  return { correct, total };
}

function evaluateBaseline (records) {
  let correct = 0, total = 0, clips = 0;
  for (const rec of records) {
    if (!rec.voiced) continue;
    const prep = prepUtterance(rec.analysis);
    if (!prep.rawSpan) continue;
    const n = prep.rawSpan.end - prep.rawSpan.start + 1;
    const spans = [];
    for (let j = 0; j < 2; j++) {
      const a = prep.rawSpan.start + Math.round((j * n) / 2);
      const b = prep.rawSpan.start + Math.round(((j + 1) * n) / 2) - 1;
      spans.push({ start: a, end: Math.max(a, b) });
    }
    const r = scoreSpans(prep, spans, rec.targetTones);
    correct += r.correct; total += r.total; clips++;
  }
  return { clips, accuracy: pct(correct, total) };
}

function evaluatePeaks (records, opts) {
  let peaksClips = 0, evenSplitClips = 0, correct = 0, total = 0;
  for (const rec of records) {
    if (!rec.voiced) continue;
    const prep = prepUtterance(rec.analysis);
    if (!prep.rawSpan) continue;
    const { spans, method } = segmentSyllables(rec.analysis.intensity, rec.analysis.pitch, 2, prep.rawSpan, opts);
    if (method === 'peaks') peaksClips++; else evenSplitClips++;
    const r = scoreSpans(prep, spans, rec.targetTones);
    correct += r.correct; total += r.total;
  }
  const totalClips = peaksClips + evenSplitClips;
  return { peaksClips, evenSplitClips, peaksPct: pct(peaksClips, totalClips), accuracy: pct(correct, total) };
}

/** Tallies correct/total per target tone (1-4) and per syllable position (0/1), in addition to overall. */
function makeBreakdownTally () {
  const byTone = { 1: [0, 0], 2: [0, 0], 3: [0, 0], 4: [0, 0] }; // [correct, total]
  const byPos = { 0: [0, 0], 1: [0, 0] };
  return {
    byTone, byPos,
    record (targetTone, pos, isCorrect) {
      byTone[targetTone][1]++; if (isCorrect) byTone[targetTone][0]++;
      byPos[pos][1]++; if (isCorrect) byPos[pos][0]++;
    },
    format () {
      const t = (label, [c, tot]) => `${label}=${fmtPct(pct(c, tot))} (${c}/${tot})`;
      return 'by tone: ' + [1, 2, 3, 4].map(k => t(`T${k}`, byTone[k])).join(', ') +
        '  |  by position: ' + [0, 1].map(k => t(`pos${k}`, byPos[k])).join(', ');
    }
  };
}

function evaluateGuided (records) {
  let guidedClips = 0, evenSplitClips = 0, correct = 0, total = 0;
  const breakdown = makeBreakdownTally();
  for (const rec of records) {
    if (!rec.voiced) continue;
    const prep = prepUtterance(rec.analysis);
    if (!prep.rawSpan) continue;
    const norm = new SpeakerNormalizer(); // throwaway: segmentSyllablesGuided never calls .add()
    const { spans, method } = segmentSyllablesGuided(prep, rec.targetTones, norm);
    if (method === 'guided') guidedClips++; else evenSplitClips++;
    spans.forEach((span, i) => {
      const f = extractSyllableFeatures(prep, span, norm);
      if (!f.voiced) return;
      const isCorrect = classify(rec.targetTones[i], f).bestTone === rec.targetTones[i];
      total++; if (isCorrect) correct++;
      breakdown.record(rec.targetTones[i], i, isCorrect);
    });
  }
  const totalClips = guidedClips + evenSplitClips;
  return { guidedClips, evenSplitClips, guidedPct: pct(guidedClips, totalClips), accuracy: pct(correct, total), breakdown };
}

/**
 * Ceiling for "any single-frame boundary, scored by the existing
 * classifier" — brute-forces EVERY internal frame as the split point
 * (not just intensity-dip candidates) and keeps whichever maximizes total
 * classify().targetScore. Only meaningful for targetCount===2 (this
 * corpus is double-syllable only), where "any boundary" is a single
 * choice, not a combinatorial search. Tells us whether segmentSyllables
 * Guided()'s restriction to intensity-minima candidates is leaving real
 * accuracy on the table, or whether we're already near the ceiling of
 * what THIS classifier can do as a segmentation-scoring model, period.
 */
function evaluateOracle (records) {
  let correct = 0, total = 0;
  const breakdown = makeBreakdownTally();
  for (const rec of records) {
    if (!rec.voiced) continue;
    const prep = prepUtterance(rec.analysis);
    if (!prep.rawSpan) continue;
    const { start, end } = prep.rawSpan;
    const n = end - start + 1;
    if (n < 4) continue; // need at least 2 frames per side
    const norm = new SpeakerNormalizer();

    const scoreAt = (a, b, toneIdx) => {
      const f = extractSyllableFeatures(prep, { start: start + a, end: start + b }, norm);
      return f.voiced ? classify(rec.targetTones[toneIdx], f).targetScore : -1;
    };
    let bestB = -1, bestScore = -Infinity;
    for (let b = 1; b < n - 2; b++) {
      const s = scoreAt(0, b, 0) + scoreAt(b + 1, n - 1, 1);
      if (s > bestScore) { bestScore = s; bestB = b; }
    }
    if (bestB === -1) continue;
    const spans = [{ start, end: start + bestB }, { start: start + bestB + 1, end }];
    spans.forEach((span, i) => {
      const f = extractSyllableFeatures(prep, span, norm);
      if (!f.voiced) return;
      const isCorrect = classify(rec.targetTones[i], f).bestTone === rec.targetTones[i];
      total++; if (isCorrect) correct++;
      breakdown.record(rec.targetTones[i], i, isCorrect);
    });
  }
  return { accuracy: pct(correct, total), breakdown };
}

function appendHistory (entry) {
  const history = existsSync(HISTORY_PATH) ? JSON.parse(readFileSync(HISTORY_PATH, 'utf8')) : [];
  history.push({ timestamp: new Date().toISOString(), ...gitInfo(), ...entry });
  mkdirSync(dirname(HISTORY_PATH), { recursive: true });
  writeFileSync(HISTORY_PATH, JSON.stringify(history, null, 2) + '\n');
  console.log(`\nAppended to ${HISTORY_PATH}`);
}

async function main () {
  const dir = resolveToneAudioDir(process.env.TONEAUDIO_DIR);
  if (!dir) { console.error('No ToneAudio_* corpus directory found.'); process.exit(1); }
  const jobs = parseInt(process.env.SEG_JOBS || '1', 10);
  const useCache = process.env.SEG_TUNE_CACHE !== '0';

  console.log('='.repeat(78));
  console.log('Guided (known-target-tone DP) segmentation vs peaks vs baseline');
  console.log('='.repeat(78));

  const records = await loadOrExtract(dir, { jobs, useCache, log: console.log });
  const voicedCount = records.filter(r => r.voiced).length;
  console.log(`${voicedCount}/${records.length} clips voiced\n`);

  const baseline = evaluateBaseline(records);
  const peaks = evaluatePeaks(records, { smoothWindowSec: 0.05, minProminenceDb: 10 });
  const guided = evaluateGuided(records);
  console.log('running unconstrained oracle search (every frame, not just intensity dips)...');
  const oracle = evaluateOracle(records);

  console.log(`\nbaseline (always even-split):        accuracy ${fmtPct(baseline.accuracy)}`);
  console.log(`peaks (best-tuned, see history):      accuracy ${fmtPct(peaks.accuracy)}  ` +
    `(method=peaks on ${fmtPct(peaks.peaksPct)} of clips)`);
  console.log(`guided (known-target-tone DP):        accuracy ${fmtPct(guided.accuracy)}  ` +
    `(method=guided on ${fmtPct(guided.guidedPct)} of clips)`);
  console.log(`oracle (any frame, unconstrained):    accuracy ${fmtPct(oracle.accuracy)}  ` +
    `— ceiling for "this classifier as segmentation scorer", period`);
  console.log(`\nDelta vs baseline: peaks ${(peaks.accuracy - baseline.accuracy).toFixed(1)}pp, ` +
    `guided ${(guided.accuracy - baseline.accuracy).toFixed(1)}pp, ` +
    `oracle ${(oracle.accuracy - baseline.accuracy).toFixed(1)}pp`);
  console.log(`Headroom left in the guided approach (oracle - guided): ${(oracle.accuracy - guided.accuracy).toFixed(1)}pp`);

  console.log(`\nguided breakdown: ${guided.breakdown.format()}`);
  console.log(`oracle breakdown: ${oracle.breakdown.format()}`);

  appendHistory({
    label: 'guided (known-target-tone DP) vs peaks vs baseline vs oracle, per-syllable tone accuracy',
    corpus: 'ToneAudio_2026-07-22',
    eligibleClips: voicedCount,
    baselineAlwaysEvenSplitAccuracy: baseline.accuracy,
    peaksAccuracy: peaks.accuracy,
    peaksPct: peaks.peaksPct,
    guidedAccuracy: guided.accuracy,
    guidedPct: guided.guidedPct,
    oracleAccuracy: oracle.accuracy,
    guidedBreakdown: { byTone: guided.breakdown.byTone, byPos: guided.breakdown.byPos },
    oracleBreakdown: { byTone: oracle.breakdown.byTone, byPos: oracle.breakdown.byPos },
    notes: `Guided segmentation (segmentSyllablesGuided): DP/Viterbi search over candidate ` +
      `intensity-dip boundaries maximizing total classify().targetScore against the KNOWN target ` +
      `tone sequence, using the app's own tone classifier as the scoring model in place of a full ` +
      `phonetic acoustic model. Delta vs baseline: ${(guided.accuracy - baseline.accuracy).toFixed(1)}pp. ` +
      `Compare against peaks' ${(peaks.accuracy - baseline.accuracy).toFixed(1)}pp (blind intensity-peak ` +
      `prominence, MEASURED AND FOUND WANTING per segmentation.js's header). Oracle = unconstrained ` +
      `every-frame boundary search (not just intensity-dip candidates), scored by the SAME classifier — ` +
      `the ceiling for "this classifier as a segmentation-scoring model," period. Headroom left in ` +
      `guided vs oracle: ${(oracle.accuracy - guided.accuracy).toFixed(1)}pp. If that headroom is small, ` +
      `the bottleneck is the classifier itself (see breakdown by tone), not the intensity-dip candidate ` +
      `restriction — more segmentation tuning wouldn't help much; a fundamentally better acoustic model ` +
      `(or fixing the classifier) would.`
  });
}

main().catch(err => { console.error(err); process.exit(2); });
