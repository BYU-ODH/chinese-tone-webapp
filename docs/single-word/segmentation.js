/*
 * Syllable segmentation for known-length multi-syllable utterances.
 *
 * Algorithm (de Jong & Wempe, 2009): candidate syllable nuclei are local
 * intensity maxima, ranked by prominence (height above the higher of the
 * two flanking intensity dips) and voicing-checked against the pitch
 * contour, so a fricative burst or noise blip can't be mistaken for a
 * syllable. This app is a closed-vocabulary drill, so the expected
 * syllable count is always known up front — segmentation only has to
 * find WHERE the boundaries are, never guess HOW MANY syllables there are.
 *
 * This is the highest-risk, highest-leverage stage of the multi-syllable
 * pipeline (see the plan's "Trust, not blind faith" section): a
 * confidently-wrong per-syllable boundary actively misleads a learner,
 * which is worse than no feedback. Two guardrails follow from that:
 *
 *   - The primary trust signal is upstream of this file: does the number
 *     of qualifying peaks match targetCount. If not enough are found
 *     (e.g. a neutral-tone syllable's suppressed peak merged into a
 *     neighbor), this falls back to an even-duration split and says so
 *     via the returned `method`, rather than guessing a boundary.
 *
 * MEASURED AND FOUND WANTING (scripts/tune-segmentation.mjs, logged in
 * scripts/results/segmentation-history.json): a 24-combo sweep of
 * minProminenceDb x smoothWindowSec against per-syllable tone-classification
 * accuracy on 1027 real double-syllable ToneAudio clips found that NO
 * combination meaningfully beats unconditionally even-splitting the clip in
 * half (best: +0.6pp over baseline, at a 36.7% peaks-detection rate; most
 * combos are worse than baseline). This isn't an untuned-threshold problem —
 * the threshold space was swept broadly. Even when this module reports
 * method:'peaks' (i.e. it found targetCount qualifying intensity peaks), the
 * resulting boundaries are not reliably closer to the true syllable
 * boundary than a blind half-split, on this corpus. Treat this technique as
 * an open research question, not load-bearing, until a fundamentally
 * different signal (e.g. Stage 2's noise-suppression tracks, or a
 * different acoustic feature than raw intensity) is tried.
 */
import { movingAverage, sampleBlockAt } from './features.js';

const DEFAULT_SMOOTH_WINDOW_SEC = 0.03; // ~30ms — smooths frame jitter without erasing syllable-scale dips
const DEFAULT_VOICING_TOLERANCE_FRAMES = 2; // a peak counts as "voiced" if any frame within this many steps is
const DEFAULT_MIN_PROMINENCE_DB = 6; // a candidate must stand out from its flanking dips by at least this
                              // much; without a floor, a long flat run (silence, a sustained plateau) is a
                              // string of trivially "local-max" points at ~0 prominence each, which
                              // could pad the candidate count past targetCount and mask a real
                              // insufficient-peaks case that should fall back to even-split instead
                              //
                              // These are UNTUNED defaults (see the file header) — overridable via the
                              // 5th `opts` argument so scripts/tune-segmentation.mjs can sweep them
                              // against real data without editing source.

/**
 * @param {{n,dx,x1,values}} intensity  full-clip Praat intensity contour
 * @param {{n,dx,x1,values}} pitch      full-clip Praat pitch contour; used
 *   only to voicing-check candidate peaks
 * @param {number} targetCount  expected syllable count for this utterance
 * @param {{start:number,end:number}} speechSpan  inclusive frame indices
 *   into pitch's grid (findSpeechSpan's output) — segmentation never
 *   looks outside this span
 * @param {object} [opts] threshold overrides (see the DEFAULT_* constants
 *   above) — smoothWindowSec, voicingToleranceFrames, minProminenceDb
 * @returns {{spans: {start:number,end:number}[], method: 'peaks'|'even-split', candidateProminences: number[]}}
 *   spans.length === targetCount always, in time order, covering
 *   speechSpan with no gaps or overlaps. candidateProminences is a
 *   diagnostic (strongest first, empty on the even-split shortcut below) —
 *   every qualifying peak's prominence, not just the ones selected; lets a
 *   caller measure how close a clip came to segmenting even on failure.
 */
export function segmentSyllables (intensity, pitch, targetCount, speechSpan, opts = {}) {
  const smoothWindowSec = opts.smoothWindowSec ?? DEFAULT_SMOOTH_WINDOW_SEC;
  const voicingToleranceFrames = opts.voicingToleranceFrames ?? DEFAULT_VOICING_TOLERANCE_FRAMES;
  const minProminenceDb = opts.minProminenceDb ?? DEFAULT_MIN_PROMINENCE_DB;

  const { start, end } = speechSpan;
  const n = end - start + 1;
  if (targetCount <= 1 || n <= 0) return { spans: [{ start, end }], method: 'peaks', candidateProminences: [] };

  const dx = pitch.dx;
  const t0 = pitch.x1;

  // Sample intensity onto pitch's own frame grid — they're independently
  // timed Praat blocks, so this mirrors findSpeechSpan's own pattern of
  // sampling everything relative to the pitch contour's indices.
  const db = new Array(n);
  const voiced = new Array(n);
  for (let k = 0; k < n; k++) {
    const i = start + k;
    db[k] = sampleBlockAt(intensity, t0 + i * dx);
    voiced[k] = Number.isFinite(pitch.values[i]) && pitch.values[i] > 0;
  }
  const smoothed = movingAverage(db, Math.max(1, Math.round(smoothWindowSec / dx)));

  const peaks = findProminentPeaks(smoothed, voiced, voicingToleranceFrames, minProminenceDb);
  // Diagnostic only (not used for the spans/method decision below): every
  // qualifying candidate's prominence, strongest first. Lets a caller
  // measure how close a clip came to segmenting even when it didn't quite
  // clear targetCount, without re-running the peak search.
  const candidateProminences = [...peaks].sort((a, b) => b.prominence - a.prominence).map(p => +p.prominence.toFixed(2));

  if (peaks.length < targetCount) {
    return { spans: evenSplit(start, end, targetCount), method: 'even-split', candidateProminences };
  }

  const chosen = peaks
    .sort((a, b) => b.prominence - a.prominence)
    .slice(0, targetCount)
    .sort((a, b) => a.index - b.index);

  const spans = [];
  let spanStart = 0;
  for (let j = 0; j < chosen.length; j++) {
    const isLast = j === chosen.length - 1;
    const spanEnd = isLast ? n - 1 : minIndexBetween(smoothed, chosen[j].index, chosen[j + 1].index);
    spans.push({ start: start + spanStart, end: start + spanEnd });
    spanStart = spanEnd + 1;
  }
  return { spans, method: 'peaks', candidateProminences };
}

/**
 * Local intensity maxima that overlap a voiced frame, each tagged with its
 * prominence: height above the higher of its two flanking dips (the
 * lowest intensity between it and its nearest neighboring peak, or the
 * span boundary if it has none on that side).
 */
function findProminentPeaks (db, voiced, voicingToleranceFrames, minProminenceDb) {
  const n = db.length;
  const raw = [];
  for (let i = 0; i < n; i++) {
    if (!Number.isFinite(db[i])) continue;
    const prevOk = i === 0 || !Number.isFinite(db[i - 1]) || db[i] >= db[i - 1];
    const nextOk = i === n - 1 || !Number.isFinite(db[i + 1]) || db[i] >= db[i + 1];
    if (prevOk && nextOk) raw.push(i);
  }
  const maxima = collapsePlateaus(raw, db);

  const out = [];
  for (let m = 0; m < maxima.length; m++) {
    const i = maxima[m];
    if (!isVoicedNear(voiced, i, voicingToleranceFrames)) continue;
    // A peak with no neighboring peak on one side (the first/last in the
    // list) has no real flanking dip on that side within the span at all —
    // NOT the same as a dip of height db[boundary]. Using the span
    // boundary's own value there is wrong whenever that boundary sits
    // inside the SAME flat run as the peak itself (collapsePlateaus
    // collapsed it to one point, so db[boundary]==db[i] and the "dip"
    // would be bogus, at the peak's own height, wiping out its
    // prominence). -Infinity means "unconstrained on this side" so
    // prominence falls back to whichever side has a real dip.
    const leftDip = m === 0 ? -Infinity : minValueBetween(db, maxima[m - 1], i);
    const rightDip = m === maxima.length - 1 ? -Infinity : minValueBetween(db, i, maxima[m + 1]);
    const prominence = db[i] - Math.max(leftDip, rightDip);
    if (prominence >= minProminenceDb) out.push({ index: i, prominence });
  }
  return out;
}

function isVoicedNear (voiced, i, voicingToleranceFrames) {
  const lo = Math.max(0, i - voicingToleranceFrames);
  const hi = Math.min(voiced.length - 1, i + voicingToleranceFrames);
  for (let k = lo; k <= hi; k++) if (voiced[k]) return true;
  return false;
}

/** Collapse consecutive equal-height indices (a flat plateau top) to their middle index. */
function collapsePlateaus (indices, db) {
  const out = [];
  let run = [];
  for (const i of indices) {
    if (run.length && i === run[run.length - 1] + 1 && db[i] === db[run[0]]) {
      run.push(i);
    } else {
      if (run.length) out.push(run[Math.floor(run.length / 2)]);
      run = [i];
    }
  }
  if (run.length) out.push(run[Math.floor(run.length / 2)]);
  return out;
}

function minValueBetween (xs, i, j) {
  let m = Infinity;
  for (let k = Math.min(i, j); k <= Math.max(i, j); k++) {
    if (Number.isFinite(xs[k]) && xs[k] < m) m = xs[k];
  }
  return Number.isFinite(m) ? m : -Infinity;
}

/** Index of the minimum value strictly between i and j (the dip to split on), defaulting to their midpoint on a tie or an all-NaN gap. */
function minIndexBetween (xs, i, j) {
  if (j - i <= 1) return Math.floor((i + j) / 2);
  let bestIdx = Math.floor((i + j) / 2);
  let bestVal = Infinity;
  for (let k = i + 1; k < j; k++) {
    if (Number.isFinite(xs[k]) && xs[k] < bestVal) { bestVal = xs[k]; bestIdx = k; }
  }
  return bestIdx;
}

/** Even-duration fallback: targetCount contiguous chunks covering [start,end] with no gaps or overlaps. */
function evenSplit (start, end, targetCount) {
  const n = end - start + 1;
  const spans = [];
  for (let j = 0; j < targetCount; j++) {
    const a = start + Math.round((j * n) / targetCount);
    const b = start + Math.round(((j + 1) * n) / targetCount) - 1;
    spans.push({ start: a, end: Math.max(a, b) });
  }
  return spans;
}
