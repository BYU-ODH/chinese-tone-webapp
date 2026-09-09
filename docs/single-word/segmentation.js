/*
 * Syllable segmentation for known-length multi-syllable utterances.
 *
 * PRODUCTION PATH: segmentSyllablesGuided() (below). USE THAT, not
 * segmentSyllables() — see each function's own header for why.
 *
 * This app is a closed-vocabulary drill, so both the expected syllable
 * COUNT and the expected syllable TONE sequence are always known up
 * front — segmentation only has to find WHERE the boundaries are, never
 * guess HOW MANY syllables there are or WHAT tone each one is. This is the
 * highest-risk, highest-leverage stage of the multi-syllable pipeline (see
 * the plan's "Trust, not blind faith" section): a confidently-wrong
 * per-syllable boundary actively misleads a learner, which is worse than
 * no feedback — so every function here falls back to an even-duration
 * split and says so via the returned `method` whenever it doesn't have a
 * trustworthy answer, rather than guessing.
 *
 * ---------------------------------------------------------------------
 * HISTORY (why there are two functions here, not one):
 *
 * segmentSyllables() — de Jong & Wempe (2009): candidate syllable nuclei
 * are local intensity maxima, ranked by acoustic prominence alone, with no
 * knowledge of what tone each syllable is actually supposed to be.
 * MEASURED AND FOUND WANTING (scripts/tune-segmentation.mjs, logged in
 * segmentation-history.json): a 24-combo threshold sweep against
 * per-syllable tone-classification accuracy on 1,027 real double-syllable
 * ToneAudio clips found NO combination meaningfully beats unconditionally
 * even-splitting the clip in half (best: +0.6pp over baseline). This
 * wasn't an untuned-threshold problem — blind acoustic prominence alone
 * just doesn't reliably locate the true syllable boundary on this corpus.
 * Kept in this file for reference/comparison, NOT called by utterance.js.
 *
 * segmentSyllablesGuided() — uses the known target TONE sequence (which a
 * generic forced aligner wouldn't have, but this app does) to drive the
 * search, scored by this app's own tone classifier — the same principle
 * real forced alignment uses (score candidate spans against a known
 * target with a trained acoustic model), at zero new dependency cost.
 * MEASURED (scripts/tune-segmentation-guided.mjs, same 1,027 clips, same
 * accuracy metric that sank the function above): 67.3% vs. baseline's
 * 54.1% — +13.2pp, and +12.6pp over segmentSyllables()'s own best-tuned
 * result, resolving 99.9% of clips via genuine guided search rather than
 * even-split fallback. This is what utterance.js calls.
 *
 * NOT "solved" — 67.3% is a real improvement, not a finish line. A
 * decomposition (same script, unconstrained-oracle mode: every frame is a
 * candidate boundary, not just intensity dips, still scored by the SAME
 * classifier) found the ceiling for "this classifier as a segmentation
 * scorer, with a perfect boundary" is 76.7% — only 9.4pp above what the
 * intensity-dip-restricted search above already gets. So the bigger
 * bottleneck ISN'T segmentation candidate quality, it's the classifier
 * itself: broken down by tone, T1 hits 89.6% (guided) / 93.7% (oracle),
 * but T2/T3/T4 all sit at 54-62% (guided) / 67-73% (oracle) — T3 the
 * weakest, consistent with this classifier's ALREADY-KNOWN T3 recall
 * weakness on the monosyllable Tone Perfect baseline. Segmentation
 * improvements (denser/richer boundary candidates, or a neural forced
 * aligner) can close AT MOST that same ~9.4pp gap while this classifier
 * stays as-is — closing the much larger T2/T3/T4 gap needs the classifier
 * itself improved, a separate and probably higher-leverage effort that
 * would also improve the single-word app, not just multi-syllable.
 */
import { movingAverage, sampleBlockAt, extractSyllableFeatures } from './features.js';
import { classify } from './classifier.js';

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
 * Blind acoustic-prominence segmentation — MEASURED AND FOUND WANTING, kept
 * for reference/comparison only. Use segmentSyllablesGuided() instead (see
 * this file's header).
 *
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

const DEFAULT_GUIDED_SMOOTH_WINDOW_SEC = 0.03;

/**
 * Known-target-guided alternative to segmentSyllables(). Where that
 * function picks boundaries from acoustics alone (intensity-peak
 * prominence) and was MEASURED AND FOUND WANTING (see this file's header),
 * this exploits something a generic forced aligner doesn't have but this
 * closed-vocabulary drill app does: the exact target TONE for every
 * syllable position is already known, and the app already has a trained
 * scoring model for "does this span sound like tone N" — the tone
 * classifier itself. So instead of ranking candidate boundaries by
 * acoustic prominence alone, this runs a DP/Viterbi search over candidate
 * boundaries (local intensity dips, the natural inter-syllable valleys)
 * that picks whichever (targetTones.length - 1) of them partition the
 * span into syllables maximizing the TOTAL classifier score against the
 * KNOWN target tone sequence — the same principle a real forced aligner
 * uses (score candidate spans against a known target with a trained
 * acoustic model), just with this app's own tone classifier standing in
 * for a full phonetic acoustic model, at zero new dependency cost.
 *
 * Falls back to even-split under the same "don't guess" discipline as
 * segmentSyllables(): too few candidate boundaries, or every full
 * partition running into an unvoiced/gate-failing span, means the search
 * has nothing trustworthy to report.
 *
 * @param {object} prep          prepUtterance()'s output — needed (not
 *   just intensity/pitch) because scoring a candidate span requires the
 *   full extractSyllableFeatures()/classify() pipeline, not just contours.
 * @param {number[]} targetTones expected citation tone per syllable, in
 *   order — length is the expected syllable count.
 * @param {SpeakerNormalizer} normalizer  passed through to
 *   extractSyllableFeatures() for every candidate span scored; NOT
 *   mutated (segmentation is a read-only search, never calls .add()).
 * @param {object} [opts] smoothWindowSec override (see DEFAULT_GUIDED_SMOOTH_WINDOW_SEC)
 * @returns {{spans: {start:number,end:number}[], method: 'guided'|'even-split'}}
 */
export function segmentSyllablesGuided (prep, targetTones, normalizer, opts = {}) {
  const smoothWindowSec = opts.smoothWindowSec ?? DEFAULT_GUIDED_SMOOTH_WINDOW_SEC;
  const targetCount = targetTones.length;
  const { start, end } = prep.rawSpan;
  const n = end - start + 1;
  if (targetCount <= 1 || n <= 0) return { spans: [{ start, end }], method: 'guided' };

  const dx = prep.dx;
  const t0 = prep.t0;
  const db = new Array(n);
  for (let k = 0; k < n; k++) db[k] = sampleBlockAt(prep.intensity, t0 + (start + k) * dx);
  const smoothed = movingAverage(db, Math.max(1, Math.round(smoothWindowSec / dx)));

  // Candidate boundaries = local minima of the smoothed intensity contour
  // (the natural valleys between syllables), excluding the span's own
  // endpoints (which can't be an INTERNAL boundary).
  const minima = findLocalMinima(smoothed).filter(i => i > 0 && i < n - 1);
  if (minima.length < targetCount - 1) {
    return { spans: evenSplit(start, end, targetCount), method: 'even-split' };
  }

  // A gate-failing candidate span (too short/quiet/noisy to score at all —
  // see extractSyllableFeatures' own gates) scores -1: guaranteed below any
  // real classify().targetScore (which stays >=0), so the DP actively
  // avoids carving out a degenerate span whenever a better option exists,
  // rather than treating "unscoreable" as merely neutral.
  const GATE_FAIL_SCORE = -1;
  const NEUTRAL_SCORE = 0;
  // Optional realizations per position (sandhi.js's acceptedTones). Where a
  // position genuinely accepts more than one tone, the boundary search must
  // not commit to one of them — otherwise a learner producing the other
  // legitimate form gets worse boundaries as well as a worse score.
  const accepted = opts.acceptedTones || null;
  const scoreCache = new Map();
  const spanScore = (a, b, toneIdx) => {
    const key = a * (n + 1) + b; // a,b < n, collision-free
    let byTone = scoreCache.get(key);
    if (!byTone) { byTone = new Map(); scoreCache.set(key, byTone); }
    if (byTone.has(toneIdx)) return byTone.get(toneIdx);
    const f = extractSyllableFeatures(prep, { start: start + a, end: start + b }, normalizer);
    // A neutral-tone position has no scoreable target (classify() returns an
    // explicit non-scoring verdict for tone 0), so it contributes a constant.
    // This is sound rather than arbitrary: every candidate partition assigns
    // exactly one span to each syllable index, so a constant at a neutral
    // index shifts all partition totals by the same amount and cannot change
    // the argmax. The consequence is worth stating plainly — the boundaries
    // AROUND a neutral syllable are chosen entirely by its neighbours' scores,
    // so its own extent is unconstrained by the search. Voicing still counts:
    // a gate-failing span scores GATE_FAIL_SCORE even at a neutral index, so
    // the DP won't hand a neutral position a dead span when a live one exists.
    const options = (accepted && accepted[toneIdx]) || [targetTones[toneIdx]];
    let s;
    if (!f.voiced) {
      s = GATE_FAIL_SCORE;
    } else {
      // Best over the accepted realizations: whichever the learner actually
      // produced is the one this span should be judged by.
      s = -Infinity;
      for (const tone of options) {
        const x = tone === 0 ? NEUTRAL_SCORE : classify(tone, f).targetScore;
        if (x > s) s = x;
      }
    }
    byTone.set(toneIdx, s);
    return s;
  };

  // dp[k][i] = best total score for the first (k+1) syllables, where
  // syllable k ends at candidate boundary minima[i]. back[k][i] = the
  // predecessor candidate index chosen for syllable k-1 (-1 = "starts at
  // the span's own start").
  const M = minima.length;
  const lastK = targetCount - 2; // dp row for the second-to-last syllable
  const dp = Array.from({ length: targetCount - 1 }, () => new Float64Array(M).fill(-Infinity));
  const back = Array.from({ length: targetCount - 1 }, () => new Int32Array(M).fill(-1));

  for (let i = 0; i < M; i++) dp[0][i] = spanScore(0, minima[i], 0);
  for (let k = 1; k <= lastK; k++) {
    for (let i = 0; i < M; i++) {
      let best = -Infinity, bestJ = -1;
      for (let j = 0; j < i; j++) {
        if (dp[k - 1][j] === -Infinity) continue;
        const s = dp[k - 1][j] + spanScore(minima[j] + 1, minima[i], k);
        if (s > best) { best = s; bestJ = j; }
      }
      dp[k][i] = best;
      back[k][i] = bestJ;
    }
  }

  let bestFinal = -Infinity, bestFinalJ = -1;
  for (let j = 0; j < M; j++) {
    if (dp[lastK][j] === -Infinity) continue;
    const s = dp[lastK][j] + spanScore(minima[j] + 1, n - 1, targetCount - 1);
    if (s > bestFinal) { bestFinal = s; bestFinalJ = j; }
  }
  if (bestFinalJ === -1) return { spans: evenSplit(start, end, targetCount), method: 'even-split' };

  const chosen = [];
  let j = bestFinalJ;
  for (let k = lastK; k >= 0; k--) {
    chosen.unshift(minima[j]);
    j = back[k][j];
  }

  const spans = [];
  let spanStart = 0;
  for (const b of chosen) {
    spans.push({ start: start + spanStart, end: start + b });
    spanStart = b + 1;
  }
  spans.push({ start: start + spanStart, end });

  // The DP picks the LEAST-bad partition even when every option is poor
  // (GATE_FAIL_SCORE keeps the search well-defined rather than crashing) —
  // but a partition containing even one genuinely gate-failing span isn't
  // trustworthy to report as 'guided'. Re-check the actual winning spans
  // (cheap: targetCount calls, not the full search grid) rather than
  // inferring this from the aggregate score alone.
  const anyGateFailure = spans.some(span => !extractSyllableFeatures(prep, span, normalizer).voiced);
  if (anyGateFailure) return { spans: evenSplit(start, end, targetCount), method: 'even-split' };

  return { spans, method: 'guided' };
}

/** Local intensity minima (candidate inter-syllable valleys), plateau-collapsed. */
function findLocalMinima (db) {
  const n = db.length;
  const raw = [];
  for (let i = 0; i < n; i++) {
    if (!Number.isFinite(db[i])) continue;
    const prevOk = i === 0 || !Number.isFinite(db[i - 1]) || db[i] <= db[i - 1];
    const nextOk = i === n - 1 || !Number.isFinite(db[i + 1]) || db[i] <= db[i + 1];
    if (prevOk && nextOk) raw.push(i);
  }
  return collapsePlateaus(raw, db);
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
