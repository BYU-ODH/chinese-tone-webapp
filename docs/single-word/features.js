/*
 * Feature extraction & speaker normalization for Mandarin tone analysis.
 *
 * Inputs come from praat-engine.analyzeWav(). Output is a feature struct
 * that the classifier consumes.
 *
 * Normalization: F0 is converted to semitones relative to a per-speaker
 * reference. The reference accumulates passively across the session — no
 * explicit calibration step. Until the speaker has produced enough
 * voiced data spanning a reasonable F0 range, we fall back to the median
 * of the current utterance and the classifier ignores register-dependent
 * features (c0, onset, offset).
 */

/* Histogram domain for accumulated log2-F0: 60–700 Hz at half-semitone
 * resolution. Praat's tracker is configured for 75–600 Hz, so everything
 * it can emit lands inside this range. */
const HIST_LO = Math.log2(60);
const HIST_HI = Math.log2(700);
const HIST_BINS = 85;
const HIST_W = (HIST_HI - HIST_LO) / HIST_BINS;

/* Cap on how many frames a single utterance may contribute. Without a
 * cap, one long recording dominates the reference. */
const MAX_FRAMES_PER_UTTERANCE = 30;

/* When the accumulated weight exceeds this, halve all bin counts. Bounds
 * the memory of stale data so the reference can track slow register
 * drift (warming up, moving relative to the mic). */
const DECAY_AT_COUNT = 600;

/**
 * Running speaker register estimator.
 *
 * Accumulates voiced log2-F0 into a fixed-bin histogram and derives the
 * reference from robust percentiles, NOT absolute min/max. Rationale: a
 * single creaky T3 (Praat halving F0) or excited onset spike must not be
 * able to shift the reference for the rest of the session — with
 * percentiles its influence is proportional to its share of the data
 * and washes out as good data accumulates.
 */
export class SpeakerNormalizer {
  constructor () {
    this.bins = new Float64Array(HIST_BINS);
    this.count = 0;             // total accumulated weight (frames)
    this.utteranceCount = 0;    // utterances that contributed frames
    this.tonesSeen = new Set(); // distinct target tones practiced
  }

  /**
   * Add voiced Hz values from one utterance. NaN/<=0 are ignored, the
   * contribution is subsampled to MAX_FRAMES_PER_UTTERANCE, and the
   * practiced target tone (1..4, optional) feeds the trust gate.
   */
  add (hzValues, targetTone) {
    const valid = [];
    for (const f of hzValues) {
      if (Number.isFinite(f) && f > 0) valid.push(f);
    }
    if (valid.length === 0) return;

    const stride = Math.max(1, Math.ceil(valid.length / MAX_FRAMES_PER_UTTERANCE));
    for (let i = 0; i < valid.length; i += stride) {
      const lg = Math.log2(valid[i]);
      let bin = Math.floor((lg - HIST_LO) / HIST_W);
      if (bin < 0) bin = 0;
      if (bin >= HIST_BINS) bin = HIST_BINS - 1;
      this.bins[bin] += 1;
      this.count += 1;
    }
    this.utteranceCount += 1;
    if (targetTone >= 1 && targetTone <= 4) this.tonesSeen.add(targetTone);

    if (this.count > DECAY_AT_COUNT) {
      for (let i = 0; i < HIST_BINS; i++) this.bins[i] *= 0.5;
      this.count *= 0.5;
    }
  }

  /** Log2-Hz at percentile p (0..1), linearly interpolated within a bin. */
  percentileLogF0 (p) {
    if (this.count <= 0) return null;
    const target = p * this.count;
    let cum = 0;
    for (let i = 0; i < HIST_BINS; i++) {
      const c = this.bins[i];
      if (cum + c >= target) {
        const within = c > 0 ? (target - cum) / c : 0.5;
        return HIST_LO + (i + within) * HIST_W;
      }
      cum += c;
    }
    return HIST_HI;
  }

  meanHz () {
    const m = this.percentileLogF0(0.5);
    return m == null ? null : Math.pow(2, m);
  }

  /** Robust F0 spread observed so far (P90 − P10), in semitones. */
  rangeSemitones () {
    if (this.count === 0) return 0;
    return 12 * (this.percentileLogF0(0.9) - this.percentileLogF0(0.1));
  }

  /**
   * The speaker reference is "trusted" only once it plausibly reflects
   * the speaker's register rather than one drilled tone. Below this bar,
   * the classifier ignores register-dependent cues (c0, onset, offset)
   * and relies on shape only.
   *
   * Gate: ≥4 utterances AND ≥2 distinct practiced tones AND a robust
   * spread (P90−P10) over 6 ST. The tone-diversity requirement matters
   * because drilling one word — the normal use pattern — centers the
   * estimate on that tone's own range, which would systematically punish
   * correct productions (e.g., drilled T1 measures c0≈0 against a target
   * of +5).
   */
  isRegisterTrusted () {
    return this.utteranceCount >= 4
      && this.tonesSeen.size >= 2
      && this.rangeSemitones() > 6;
  }

  /** Reference log2-Hz to use for normalization. */
  referenceLogF0 (fallbackHz) {
    if (this.isRegisterTrusted()) {
      // Midpoint of the robust spread — approximates mid-register
      // without letting tail frames (creak, octave errors) move it.
      return (this.percentileLogF0(0.1) + this.percentileLogF0(0.9)) / 2;
    }
    if (this.count > 0) return this.percentileLogF0(0.5);
    return fallbackHz > 0 ? Math.log2(fallbackHz) : null;
  }

  /**
   * Convert each Hz value to semitones re the speaker reference.
   * Falls back to fallbackHz (typically the median of the current
   * utterance) when no reference exists yet.
   */
  semitonesRe (hzValues, fallbackHz) {
    const refLog = this.referenceLogF0(fallbackHz);
    if (refLog == null) return hzValues.map(_ => NaN);
    return hzValues.map(f =>
      Number.isFinite(f) && f > 0 ? 12 * (Math.log2(f) - refLog) : NaN
    );
  }
}

/* ------------------------------------------------------------------ */
/*  Legendre polynomial fit (orders 0..3)                              */
/* ------------------------------------------------------------------ */

function legendreBasis (t, maxOrder) {
  // Recurrence: (n+1) L_{n+1} = (2n+1) t L_n - n L_{n-1}
  const out = new Array(maxOrder + 1);
  out[0] = 1;
  if (maxOrder >= 1) out[1] = t;
  for (let n = 1; n < maxOrder; n++) {
    out[n + 1] = ((2 * n + 1) * t * out[n] - n * out[n - 1]) / (n + 1);
  }
  return out;
}

/** Gauss-Jordan solve for small systems. Returns x s.t. A x = b. */
function solveLinear (A, b) {
  const n = A.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let i = 0; i < n; i++) {
    let pivotRow = i;
    for (let r = i + 1; r < n; r++) {
      if (Math.abs(M[r][i]) > Math.abs(M[pivotRow][i])) pivotRow = r;
    }
    if (pivotRow !== i) [M[i], M[pivotRow]] = [M[pivotRow], M[i]];
    const piv = M[i][i];
    if (Math.abs(piv) < 1e-12) return new Array(n).fill(0);
    for (let j = i; j <= n; j++) M[i][j] /= piv;
    for (let r = 0; r < n; r++) {
      if (r === i) continue;
      const f = M[r][i];
      if (f === 0) continue;
      for (let j = i; j <= n; j++) M[r][j] -= f * M[i][j];
    }
  }
  return M.map(row => row[n]);
}

/**
 * Fit Legendre polynomial of given order to (times, values) by least squares.
 * Times are mapped to [-1, 1] over the span of the input.
 * Handles non-uniform sampling (i.e., unvoiced gaps in the middle).
 */
export function legendreFit (times, values, order = 3) {
  const N = values.length;
  const k = order + 1;
  if (N < k) return new Array(k).fill(0);

  const t0 = times[0];
  const tN = times[N - 1];
  const span = tN - t0;
  if (!(span > 0)) return new Array(k).fill(0);

  const ATA = Array.from({ length: k }, () => new Array(k).fill(0));
  const ATy = new Array(k).fill(0);

  for (let i = 0; i < N; i++) {
    const t = -1 + 2 * (times[i] - t0) / span;
    const b = legendreBasis(t, order);
    for (let m = 0; m < k; m++) {
      ATy[m] += b[m] * values[i];
      for (let n = 0; n < k; n++) ATA[m][n] += b[m] * b[n];
    }
  }
  return solveLinear(ATA, ATy);
}

/* ------------------------------------------------------------------ */
/*  Top-level feature extraction                                       */
/* ------------------------------------------------------------------ */

const MIN_VOICED_FRAMES = 8;
const MIN_VOICED_DURATION_SEC = 0.10;
const MIN_HNR_FOR_SCORING = 3;       // dB, very lenient — full silence/noise sits below this
const MAX_BRIDGE_GAP_SEC = 0.10;     // bridge tracker dropouts up to 100 ms

// Intensity drop that bounds the vowel nucleus. Deliberately generous: on real
// speech much of the tone's F0 movement lives in the lower-intensity sonorant
// onset/offset glides, so a tight gate (6 dB) discards tone-bearing frames and
// hurts classification. 15 dB keeps the glides while still excluding near-silent
// edges and inter-syllable dips. (Tuned on old/backend/sounds — see test_realaudio.mjs.)
const VOWEL_CORE_DROP_DB = 15;
const VOWEL_CORE_HNR_DROP = 8;     // dB below the loud-frame median HNR marking a consonant edge
const VOWEL_CORE_ERODE_CAP = 0.4;  // max fraction of the span HNR erosion may trim
const MIN_CORE_FRAMES = 6;         // floor so the order-3 Legendre fit stays well-posed

/**
 * Extract features from a Praat analysis. Always returns a struct, but
 * .voiced=false signals the analysis was unreliable (caller should not
 * score it; UI should say "couldn't hear that").
 */
export function extractFeatures (analysis, normalizer) {
  const { pitch, intensity, harmonicity, hnrMean, jitter, duration } = analysis;
  const N = pitch.n;
  const t0 = pitch.x1;
  const dx = pitch.dx;
  const rawHz = pitch.values;

  // Find span of *originally* voiced frames. We keep this count for the
  // confidence gate so we don't trust an analysis that was carried by
  // bridging alone.
  let firstV = -1;
  let lastV = -1;
  let voicedCount = 0;
  for (let i = 0; i < N; i++) {
    if (Number.isFinite(rawHz[i]) && rawHz[i] > 0) {
      if (firstV < 0) firstV = i;
      lastV = i;
      voicedCount++;
    }
  }

  // Bridge short voicing dropouts inside the voiced span. Praat's tracker
  // routinely drops 1–4 frames in creaky T3 dips and at register
  // transitions; without bridging the contour shatters and the fit
  // misses the dip entirely. Gaps longer than MAX_BRIDGE_GAP_SEC are
  // preserved (likely real silence).
  const maxBridgeFrames = Math.max(1, Math.round(MAX_BRIDGE_GAP_SEC / dx));
  const hz = bridgeShortNaNRuns(rawHz, firstV, lastV, maxBridgeFrames);

  // Confidence gate: too little voiced signal, refuse to score.
  if (voicedCount < MIN_VOICED_FRAMES) {
    return {
      voiced: false,
      reason: voicedCount === 0 ? 'no-voice' : 'too-short-voiced',
      voicedFrameCount: voicedCount,
      duration,
      hnrMean,
      jitter
    };
  }
  if (hnrMean !== -99 && hnrMean < MIN_HNR_FOR_SCORING) {
    return {
      voiced: false,
      reason: 'low-hnr',
      voicedFrameCount: voicedCount,
      duration,
      hnrMean,
      jitter
    };
  }

  // Build packed voiced contour, per-sample times, and per-frame intensity +
  // harmonicity (linearly interpolated from their contours). Intensity gates
  // which frames feed the speaker reference; intensity + HNR together isolate
  // the vowel nucleus from voiced consonants. The harmonicity block may be
  // absent on older/synthetic input — sampleBlockAt returns NaN there, which
  // makes the HNR veto inert and falls back to an intensity-only core.
  const voicedHz = [];
  const voicedTimes = [];
  const voicedDb = [];
  const voicedHnr = [];
  for (let i = firstV; i <= lastV; i++) {
    if (Number.isFinite(hz[i]) && hz[i] > 0) {
      const t = t0 + i * dx;
      voicedHz.push(hz[i]);
      voicedTimes.push(t);
      voicedDb.push(sampleBlockAt(intensity, t));
      voicedHnr.push(sampleBlockAt(harmonicity, t));
    }
  }
  const voicedDur = voicedTimes[voicedTimes.length - 1] - voicedTimes[0];
  if (voicedDur < MIN_VOICED_DURATION_SEC) {
    return {
      voiced: false,
      reason: 'too-short-voiced',
      voicedFrameCount: voicedCount,
      duration,
      hnrMean,
      jitter
    };
  }

  // Median Hz, used as fallback when no calibration reference exists. Computed
  // over the full voiced span so the median fallback and display contour reflect
  // everything that was heard, not just the nucleus.
  const sorted = [...voicedHz].sort((a, b) => a - b);
  const medianHz = sorted[sorted.length >> 1];

  // Isolate the vowel nucleus: the loudest contiguous span (the sonority peak),
  // with low-periodicity edge frames vetoed by HNR. Voiced consonants (nasals,
  // /l/, /r/, voiced fricatives) carry F0 but sit on lower-intensity, lower-HNR
  // shoulders; restricting the fit to the core keeps them out of the tone shape.
  const core = findVowelCore(voicedDb, voicedHnr);
  const coreHz = voicedHz.slice(core.start, core.end);
  const coreTimes = voicedTimes.slice(core.start, core.end);

  // Normalize to semitones re speaker mean (or median fallback). Fit is over the
  // nucleus only; medianHz still comes from the full span (above).
  const coreSemitones = normalizer.semitonesRe(coreHz, medianHz);

  // Smooth lightly with a 3-point moving average to reduce per-frame jitter
  // before fitting. Median-of-3 would be more robust but harder to vectorize;
  // mean-of-3 is fine for the polynomial projection.
  const smoothed = movingAverage(coreSemitones, 3);

  // Fit Legendre polynomials over the vowel nucleus.
  const coefs = legendreFit(coreTimes, smoothed, 3);

  // Safety valve: a trusted reference can still be wrong for this
  // utterance (octave-tracking error, or the reference itself is off).
  // No tone lives more than an octave from mid-register, so when |c0|
  // is implausible, score this utterance shape-only rather than punish it.
  let registerTrusted = normalizer.isRegisterTrusted();
  if (registerTrusted && Math.abs(coefs[0]) > 12) registerTrusted = false;

  // Onset / offset: first / last 15% of the vowel nucleus (smoothed is the core
  // subset), so onset reflects where the vowel begins, not a prevocalic nasal.
  const onsetSlice = sliceFraction(smoothed, 0, 0.15);
  const offsetSlice = sliceFraction(smoothed, 0.85, 1);
  const onset = mean(onsetSlice);
  const offset = mean(offsetSlice);

  // Intensity contour summary.
  const intVals = intensity.values.filter(v => Number.isFinite(v));
  const intMean = mean(intVals);
  const intStartV = mean(sliceFraction(intVals, 0, 0.2));
  const intEndV = mean(sliceFraction(intVals, 0.8, 1));
  const intSlope = (intEndV - intStartV) / Math.max(0.05, voicedDur);

  // Display contour: dense, with NaN gaps preserved, in normalized units.
  const refLog = normalizer.referenceLogF0(medianHz);
  const displayTimes = [];
  const displayValues = [];
  for (let i = firstV; i <= lastV; i++) {
    displayTimes.push(t0 + i * dx);
    if (Number.isFinite(hz[i]) && hz[i] > 0) {
      displayValues.push(12 * (Math.log2(hz[i]) - refLog));
    } else {
      displayValues.push(NaN);
    }
  }

  // Filtered subset of voiced Hz values that's safe to add to the running
  // speaker reference. Three guards:
  //   1. Drop first/last 15% — register transitions, F0 not steady-state.
  //   2. Intensity gate: keep only frames within 10 dB of the peak voiced
  //      intensity, so weak/breathy tail-offs and quiet-noise voicing
  //      don't drag the running min/max around.
  //   3. Outlier clip: drop values >9 semitones from the core median, to
  //      reject occasional octave errors (which sit at exactly ±12 ST).
  const referenceFrames = filterReferenceFrames(voicedHz, voicedDb);

  return {
    voiced: true,
    registerTrusted,
    voicedFrameCount: voicedCount,
    vowelCoreFrames: core.end - core.start,
    voicedDuration: voicedDur,
    duration,
    medianHz,
    coefs,                    // [c0, c1, c2, c3]
    onset,
    offset,
    intMean,
    intSlope,
    hnrMean,
    jitter,
    displayTimes,
    displayValues,
    voicedHz,                 // all voiced Hz, raw
    referenceFrames           // filtered subset for normalizer.add()
  };
}

/**
 * Filter voiced frames down to those that should contribute to the
 * speaker's running register reference. See the call site for what each
 * guard targets.
 */
function filterReferenceFrames (hz, db) {
  const N = hz.length;
  if (N === 0) return [];

  const edge = Math.floor(N * 0.15);
  const coreHz = hz.slice(edge, N - edge);
  const coreDb = db.slice(edge, N - edge);
  if (coreHz.length === 0) return [];

  let peakDb = -Infinity;
  for (const v of coreDb) if (Number.isFinite(v) && v > peakDb) peakDb = v;
  const dbCutoff = Number.isFinite(peakDb) ? peakDb - 10 : -Infinity;

  const loud = [];
  for (let i = 0; i < coreHz.length; i++) {
    if (!Number.isFinite(coreDb[i]) || coreDb[i] >= dbCutoff) {
      loud.push(coreHz[i]);
    }
  }
  if (loud.length < 4) return loud;

  const sorted = [...loud].sort((a, b) => a - b);
  const medLog = Math.log2(sorted[sorted.length >> 1]);
  const out = [];
  for (const f of loud) {
    if (Math.abs(12 * (Math.log2(f) - medLog)) <= 9) out.push(f);
  }
  return out;
}

/**
 * Linear interpolation of a Praat sampled block ({n,dx,x1,values}) at time t.
 * Returns NaN for a missing/empty block so callers degrade gracefully.
 */
function sampleBlockAt (blk, t) {
  if (!blk) return NaN;
  const { n, dx, x1, values } = blk;
  if (n <= 0 || !(dx > 0)) return NaN;
  const idx = (t - x1) / dx;
  if (idx <= 0) return values[0];
  if (idx >= n - 1) return values[n - 1];
  const i0 = Math.floor(idx);
  const f = idx - i0;
  const a = values[i0];
  const b = values[i0 + 1];
  if (!Number.isFinite(a)) return Number.isFinite(b) ? b : NaN;
  if (!Number.isFinite(b)) return a;
  return a * (1 - f) + b * f;
}

/**
 * Isolate the vowel nucleus from a voiced span by sonority. Returns
 * {start, end} (inclusive/exclusive) indices into the voiced arrays.
 *
 * Two stages, both robust to the noise in real recordings:
 *
 *   1. Intensity span. The vowel is the syllable's loudness peak; we grow a
 *      contiguous span out from that peak while intensity stays within
 *      VOWEL_CORE_DROP_DB of it. The drop is generous (15 dB) on purpose: a
 *      tight gate also discards the lower-intensity sonorant glides where much
 *      of the tone's F0 movement lives, which badly hurts classification on
 *      real speech. 15 dB keeps the glides while excluding near-silent edges.
 *
 *   2. HNR edge-erosion. Voiced consonants (onset/coda nasals, /l/, /r/, voiced
 *      fricatives) are less periodic than the vowel, so they show a lower HNR.
 *      We erode contiguous low-HNR runs inward from each END only — never from
 *      the interior — referenced to the MEDIAN HNR of the loud frames (a single
 *      ~99 dB clamp spike must not move the reference) and capped at
 *      VOWEL_CORE_ERODE_CAP of the span so noisy HNR can never eat the vowel.
 *      Eroding only the ends is what makes this safe: interior HNR dips (common
 *      in real speech) are ignored.
 *
 * Gating on intensity rather than F0 means T3 is correct by construction: the
 * F0 dips low but the vowel stays loud, so the whole dip is kept.
 */
function findVowelCore (voicedDb, voicedHnr) {
  const N = voicedDb.length;
  if (N <= MIN_CORE_FRAMES) return { start: 0, end: N };

  // Peak intensity = the vowel center.
  let peakDb = -Infinity;
  let peakIdx = 0;
  for (let i = 0; i < N; i++) {
    if (Number.isFinite(voicedDb[i]) && voicedDb[i] > peakDb) {
      peakDb = voicedDb[i];
      peakIdx = i;
    }
  }
  const dbCutoff = peakDb - VOWEL_CORE_DROP_DB;
  // Non-finite intensity counts as loud, so an interpolation gap never truncates
  // the contiguous span.
  const isLoud = (i) => !Number.isFinite(voicedDb[i]) || voicedDb[i] >= dbCutoff;

  // Stage 1: grow the contiguous loud span around the peak.
  let start = peakIdx;
  let end = peakIdx + 1;        // exclusive
  while (start > 0 && isLoud(start - 1)) start--;
  while (end < N && isLoud(end)) end++;

  // Stage 2: erode low-HNR consonant runs inward from each end.
  const loudHnr = [];
  for (let i = start; i < end; i++) {
    if (Number.isFinite(voicedHnr[i])) loudHnr.push(voicedHnr[i]);
  }
  loudHnr.sort((a, b) => a - b);
  const medianHnr = loudHnr.length ? loudHnr[loudHnr.length >> 1] : NaN;
  const hnrCutoff = Number.isFinite(medianHnr) ? medianHnr - VOWEL_CORE_HNR_DROP : -Infinity;
  const hnrLow = (i) => Number.isFinite(voicedHnr[i]) && voicedHnr[i] < hnrCutoff;

  const maxErode = Math.floor((end - start) * VOWEL_CORE_ERODE_CAP);
  let eroded = 0;
  while (end - start > MIN_CORE_FRAMES && eroded < maxErode && hnrLow(start)) { start++; eroded++; }
  while (end - start > MIN_CORE_FRAMES && eroded < maxErode && hnrLow(end - 1)) { end--; eroded++; }

  // Floor the core size so the order-3 fit stays well-posed, widening
  // symmetrically around the peak until we reach MIN_CORE_FRAMES or the bounds.
  while (end - start < MIN_CORE_FRAMES && (start > 0 || end < N)) {
    if (start > 0) start--;
    if (end - start < MIN_CORE_FRAMES && end < N) end++;
  }

  return { start, end };
}

/* ------------------------------------------------------------------ */
/*  Small helpers                                                       */
/* ------------------------------------------------------------------ */

function mean (xs) {
  if (xs.length === 0) return 0;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

function sliceFraction (xs, lo, hi) {
  const a = Math.floor(xs.length * lo);
  const b = Math.max(a + 1, Math.ceil(xs.length * hi));
  return xs.slice(a, b);
}

/**
 * Linear-in-log-Hz interpolation across NaN runs of length <= maxRun
 * inside the voiced span [first, last]. Leading/trailing NaNs and
 * longer runs are left untouched.
 */
function bridgeShortNaNRuns (hz, first, last, maxRun) {
  if (first < 0 || last < 0) return hz.slice();
  const out = hz.slice();
  let i = first + 1;
  while (i <= last) {
    if (Number.isFinite(out[i]) && out[i] > 0) { i++; continue; }
    let j = i;
    while (j <= last && !(Number.isFinite(out[j]) && out[j] > 0)) j++;
    const runLen = j - i;
    if (runLen <= maxRun && i > 0 && j <= last
        && Number.isFinite(out[i - 1]) && Number.isFinite(out[j])) {
      const logA = Math.log2(out[i - 1]);
      const logB = Math.log2(out[j]);
      const denom = (j - (i - 1));
      for (let k = i; k < j; k++) {
        const u = (k - (i - 1)) / denom;
        out[k] = Math.pow(2, logA + (logB - logA) * u);
      }
    }
    i = j + 1;
  }
  return out;
}

function movingAverage (xs, w) {
  const half = w >> 1;
  const out = new Array(xs.length);
  for (let i = 0; i < xs.length; i++) {
    let s = 0;
    let n = 0;
    for (let j = -half; j <= half; j++) {
      const k = i + j;
      if (k >= 0 && k < xs.length && Number.isFinite(xs[k])) {
        s += xs[k];
        n++;
      }
    }
    out[i] = n > 0 ? s / n : xs[i];
  }
  return out;
}
