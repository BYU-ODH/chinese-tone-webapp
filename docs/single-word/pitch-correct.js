/*
 * Pitch correction: turn a scored utterance into the time→Hz contour that
 * the learner's own recording SHOULD have had.
 *
 * Pure and DOM-free (like result.js and unlike the component that consumes
 * it), so test_pitch_correct.mjs can run the whole thing headlessly against
 * real corpus audio and measure whether the corrected audio actually hits
 * the target — the only way to know this feature works, since "it sounds
 * right" is not a thing a test suite can assert.
 *
 * ---------------------------------------------------------------------
 * WHAT GETS CORRECTED, AND WHAT DELIBERATELY DOESN'T
 *
 * Corrected: every syllable that was both scored (voiced, reliable enough
 * to judge) and has a target band. Those get the target's exact Legendre
 * curve — the same coefficients the canvas draws and the classifier scores
 * against — laid over the window the SCORE was computed on (the vowel core;
 * see targetSemitones below for why that window and not the drawn one, and
 * what breaks if you use the span instead). What the learner hears is what
 * the app just told them they should have said.
 *
 * NOT corrected, and left exactly as recorded:
 *   - neutral-tone syllables. There is no validated neutral target (see
 *     classifier.js's tone-0 guard and viz.js's no-band case), so there is
 *     nothing honest to move them to.
 *   - syllables the analyzer couldn't score. If we couldn't measure it we
 *     have no business asserting what it should have been.
 *   - syllables with too little periodic content for PSOLA to retime (see
 *     MIN_VOICED_FRACTION), which would otherwise come back unchanged and
 *     be presented as corrected.
 *   - everything outside the segmented span: leading/trailing silence,
 *     breath, room noise.
 *
 * ---------------------------------------------------------------------
 * REGISTER vs. SHAPE (the `mode` field)
 *
 * The target coefficients are in semitones re the speaker's register, so
 * turning them into Hz needs an anchor, and which anchor is honest depends
 * on the same trust question the classifier already asks:
 *
 *   'register' — the speaker reference is trusted, so the anchor IS that
 *     reference. A learner who produced the right shape an octave too low
 *     hears it corrected in pitch height too, because we actually know
 *     where their register sits.
 *
 *   'shape' — the reference isn't trusted yet (early session, or the
 *     classifier vetoed it for this utterance). The anchor is instead
 *     chosen so the corrected contour has the same mean pitch as what the
 *     learner produced: they hear their own pitch height with the right
 *     SHAPE laid over it. This mirrors viz.js's contourShift() exactly —
 *     in this regime the app scores shape only, draws shape only, and so
 *     it corrects shape only. Inventing a register correction from an
 *     untrusted reference would resynthesize a stranger's pitch height
 *     into the learner's mouth and present it as their own voice.
 */

import { movingAverage } from './features.js';
import { PITCH_FLOOR_HZ, PITCH_CEILING_HZ } from './praat-analysis.js';

/*
 * Smoothing window applied to the finished contour before it becomes pitch
 * points. Its real job is the seam between adjacent syllables: two target
 * curves meeting at a boundary can differ by 9+ semitones (T4's -4.3 ST
 * endpoint into T1's +5 ST), and across continuously voiced audio — a nasal
 * coda into the next onset — an instantaneous jump is heard as a click, not
 * as a tone change. 25 ms turns the step into a transition about as fast as
 * a real speaker's, without visibly flattening the polynomials themselves
 * (they are already smooth at this scale). It also lightly de-jitters the
 * UNCORRECTED stretches, which is a free win: frame-level tracker jitter
 * re-imposed through PSOLA sounds rough.
 */
const SMOOTH_SEC = 0.025;

/*
 * A syllable is only correctable if the tracker actually found voice across
 * this fraction of the window being rewritten.
 *
 * PSOLA moves pitch by retiming glottal pulses. Where there are no pulses —
 * a syllable swallowed into creak, a whispered or half-articulated attempt —
 * there is nothing to retime, and the resynthesis hands back audio byte-for-
 * byte identical to the input. The learner then presses "play your corrected
 * voice" and hears their own uncorrected recording, with the app implying it
 * is the fixed version. That is the worst outcome this feature can produce:
 * not a bad correction, but a false one.
 *
 * Measured on real ToneAudio clips (test_pitch_correct.mjs prints the table):
 * above 50% voiced, the corrected audio tracks the requested contour to a
 * median of 0.01-0.19 semitones; the one syllable below it missed by 7.35.
 * The bar is set at the point where the mechanism gives out, not lower —
 * plenty of perfectly correctable syllables have gappy contours, and
 * refusing those would cost the learner feedback for nothing.
 */
const MIN_VOICED_FRACTION = 0.5;

/** Legendre orders 0..3 evaluated at tn in [-1, +1]. Same curve as viz.js. */
function legendreAt (coefs, tn) {
  return (coefs[0] || 0)
    + (coefs[1] || 0) * tn
    + (coefs[2] || 0) * (3 * tn * tn - 1) / 2
    + (coefs[3] || 0) * (5 * tn * tn * tn - 3 * tn) / 2;
}

/**
 * Build the corrected pitch contour for one scored utterance.
 *
 * @param {object} analysis   the Praat analysis struct the utterance was
 *   scored from (praat-analysis.js). Only `pitch` and `duration` are read.
 * @param {object} res        extractUtteranceFeatures()'s return value —
 *   needs `.syllables` and `.spans` (frame indices into the pitch grid).
 * @param {Array<{tone:number, coefs:number[]}|null>} targets  per syllable,
 *   in order; null for a syllable with no target band (neutral tone).
 * @param {SpeakerNormalizer} normalizer  read-only; never updated here.
 * @returns {{points: {time:number, hz:number}[], mode: 'register'|'shape',
 *   anchorsHz: (number|null)[], correctedSyllables: number[]}|null}
 *   null when there is nothing to correct — no scored syllable has a
 *   target — in which case the caller should not offer the playback at all
 *   rather than offering audio identical to the original.
 */
export function buildCorrectedPitchPoints (analysis, res, targets, normalizer) {
  if (!analysis || !analysis.pitch || !res || !res.voiced) return null;
  if (!Array.isArray(res.spans) || !Array.isArray(res.syllables)) return null;

  const { n: N, dx, x1: t0, values: hz } = analysis.pitch;
  if (!(N > 0) || !(dx > 0) || !hz || hz.length < N) return null;

  const spans = res.spans;
  const correctable = spans.map((_span, i) => {
    const f = res.syllables[i];
    const t = targets && targets[i];
    return !!(f && f.voiced && t && Array.isArray(t.coefs) && t.coefs.length >= 4);
  });
  if (!correctable.some(Boolean)) return null;

  // Frame → syllable index (-1 outside every span). Spans are contiguous and
  // inclusive (segmentation.js), so this is a partition of the voiced span.
  const owner = new Int32Array(N).fill(-1);
  spans.forEach((s, i) => {
    const a = Math.max(0, s.start);
    const b = Math.min(N - 1, s.end);
    for (let k = a; k <= b; k++) owner[k] = i;
  });

  /*
   * The curve is laid over each syllable's VOWEL CORE — the window the
   * Legendre fit was taken over — not across its full span, and outside the
   * core it holds at the endpoint value.
   *
   * This is the difference between a correction that measures right and one
   * that doesn't. `coefs` are normalized time across the CORE, so a T4 whose
   * target is c1 = -5 ST means "fall five semitones across the core". Spread
   * that same curve over the whole span (typically ~1.8x longer, because the
   * core excludes the quieter consonantal shoulders) and the core only sees
   * the middle of it: re-measured, that T4 comes back at c1 ≈ -2.6, barely
   * more than half the fall asked for, and gets marked wrong — which is
   * exactly what happened before this was anchored on the core. The learner
   * would have heard a correction the app itself would fail.
   *
   * Holding the endpoint value outside the core, rather than extrapolating
   * the polynomial, is both the safe choice (a cubic continued past its
   * domain diverges fast) and the natural-sounding one: T4 completes its
   * fall and stays low, T2 rises and stays high, T3 dips and recovers. The
   * smoothing pass below rounds the joins.
   */
  const coreFrames = spans.map((span, i) => {
    if (!correctable[i]) return null;
    const f = res.syllables[i];
    const toFrame = t => (t - t0) / dx;
    const a = Number.isFinite(f.coreStartTime) ? toFrame(f.coreStartTime) : span.start;
    const b = Number.isFinite(f.coreEndTime) ? toFrame(f.coreEndTime) : span.end;
    return (b > a) ? { start: a, end: b } : { start: span.start, end: span.end };
  });

  const targetSemitones = (syl, frame) => {
    const c = coreFrames[syl];
    const width = c.end - c.start;
    let u = width > 0 ? (frame - c.start) / width : 0.5;
    if (u < 0) u = 0;
    else if (u > 1) u = 1;
    return legendreAt(targets[syl].coefs, 2 * u - 1);
  };

  // --- Anchor: semitones re speaker register → absolute log2 Hz ---------
  // Trust the register only if the normalizer trusts it AND every syllable
  // we're about to correct was itself scored in the register-trusted regime
  // (extractSyllableFeatures vetoes it per-syllable on an implausible c0,
  // e.g. an octave-tracking error). One vetoed syllable means the reference
  // is wrong for this utterance, so the whole utterance falls back to shape.
  const registerTrusted = normalizer.isRegisterTrusted() &&
    correctable.every((c, i) => !c || res.syllables[i].registerTrusted);

  // One anchor per syllable — ONE SHARED anchor in register mode, a separate
  // one per syllable in shape mode. That split is not a convenience; it is
  // viz.js's contourShift() transposed from pixels to hertz. Register-trusted,
  // viz draws every syllable in absolute speaker-relative coordinates
  // (shift 0), so one global anchor reproduces the picture and inter-syllable
  // register differences are corrected along with everything else. Shape-only,
  // viz recenters EACH syllable's contour on its OWN band, because in that
  // regime the app does not claim to know where the syllable sat in the
  // speaker's range — so anchoring the audio per syllable is what keeps the
  // recording saying the same thing as the canvas.
  //
  // It also contains the damage from a mis-tracked syllable. Octave halving
  // in creak is this pipeline's oldest known failure, and on a measured clip
  // it put one syllable's whole span at 125 Hz while its neighbour sat at
  // 250 Hz. Shared anchoring averages that error across the utterance and
  // drags the GOOD syllable off the learner's pitch too; per-syllable
  // anchoring confines it to the syllable the analyzer already got wrong and
  // already marked wrong on screen.
  const anchorsLog = new Array(spans.length).fill(null);

  if (registerTrusted) {
    const refLog = normalizer.referenceLogF0(0);
    if (refLog == null || !Number.isFinite(refLog)) return null;
    correctable.forEach((c, i) => { if (c) anchorsLog[i] = refLog; });
  } else {
    correctable.forEach((c, i) => {
      if (!c) return;
      const f = res.syllables[i];
      // Put the target's mean (its c0) exactly where the learner's own scored
      // contour sat. That level is read off the VOWEL-CORE fit — coefs[0] is
      // by construction the core's mean — never off the raw frames in the
      // span. The distinction decides the feature on real recordings: Praat
      // reports a "voiced" F0 through creak, consonant closures and octave
      // errors, and on the clip above 115 of 236 voiced frames sat an octave
      // below the median. Averaging those anchors the correction ~7 semitones
      // flat and hands back a recording pitched below the learner's own
      // voice. The core fit is already intensity- and HNR-gated against
      // exactly that junk (see extractSyllableFeatures), so reusing it means
      // the audio, the score and the drawn contour rest on one measurement.
      const refLog = normalizer.referenceLogF0(f.medianHz);
      if (refLog == null || !Number.isFinite(refLog)) return;
      const level = refLog + f.coefs[0] / 12;        // learner's core mean, log2 Hz
      anchorsLog[i] = level - targets[i].coefs[0] / 12;
    });
  }

  // A syllable whose anchor couldn't be established isn't correctable.
  correctable.forEach((c, i) => {
    if (c && !Number.isFinite(anchorsLog[i])) correctable[i] = false;
  });

  // Nor is one with too little periodic content to retime (see
  // MIN_VOICED_FRACTION). Dropped here rather than earlier so the anchor
  // arithmetic above is unaffected by which syllables survive this gate.
  correctable.forEach((c, i) => {
    if (!c) return;
    const core = coreFrames[i];
    const a = Math.max(0, Math.ceil(core.start));
    const b = Math.min(N - 1, Math.floor(core.end));
    let total = 0;
    let voiced = 0;
    for (let k = a; k <= b; k++) {
      total++;
      if (Number.isFinite(hz[k]) && hz[k] > 0) voiced++;
    }
    if (total > 0 && voiced / total < MIN_VOICED_FRACTION) correctable[i] = false;
  });

  if (!correctable.some(Boolean)) return null;

  // --- Desired contour, frame by frame, in log2 Hz ----------------------
  // Corrected syllables get the target curve at every frame of their span,
  // including frames the tracker called unvoiced: a voiceless consonant in
  // the middle of a syllable has no pulses to retime, so a pitch point over
  // it is inert, and specifying one keeps the tier continuous across it
  // instead of letting Praat interpolate across a hole.
  const desiredLog = new Array(N);
  for (let k = 0; k < N; k++) {
    const i = owner[k];
    if (i >= 0 && correctable[i]) {
      desiredLog[k] = anchorsLog[i] + targetSemitones(i, k) / 12;
    } else {
      const f = hz[k];
      desiredLog[k] = (Number.isFinite(f) && f > 0) ? Math.log2(f) : NaN;
    }
  }

  // Smooth in the log domain (semitones are log pitch; smoothing raw Hz
  // would bias every transition downward). movingAverage already ignores
  // NaN neighbours, so unvoiced gaps don't drag the ends of a run.
  const window = Math.max(3, Math.round(SMOOTH_SEC / dx) | 1);
  const smoothed = movingAverage(desiredLog, window);

  const tMax = analysis.duration > 0 ? analysis.duration : t0 + (N - 1) * dx;
  const points = [];
  for (let k = 0; k < N; k++) {
    const v = smoothed[k];
    if (!Number.isFinite(v)) continue;
    const time = t0 + k * dx;
    if (time < 0 || time > tMax) continue;
    // Clamp to the tracker's own range: a point outside it describes a pitch
    // this pipeline could not have measured and cannot meaningfully re-impose.
    const f = Math.min(PITCH_CEILING_HZ, Math.max(PITCH_FLOOR_HZ, Math.pow(2, v)));
    points.push({ time, hz: f });
  }
  // Praat needs two points to define a contour; one is a constant pitch, and
  // a "corrected" recording on a monotone is worse than no feature at all.
  if (points.length < 2) return null;

  return {
    points,
    mode: registerTrusted ? 'register' : 'shape',
    // Per syllable, null where nothing was corrected. In register mode every
    // entry is the same trusted reference; in shape mode they differ.
    anchorsHz: anchorsLog.map(a => (Number.isFinite(a) ? Math.pow(2, a) : null)),
    correctedSyllables: correctable.reduce((acc, c, i) => (c ? acc.concat(i) : acc), [])
  };
}

/**
 * Single-syllable convenience wrapper: same rules, one span. Lets the
 * single-word app share this logic verbatim with the phrase trainer rather
 * than keeping a second, drifting copy of it.
 *
 * @param {object} analysis    Praat analysis struct
 * @param {object} features    extractFeatures()'s return value (carries `span`)
 * @param {{tone:number, coefs:number[]}|null} target
 * @param {SpeakerNormalizer} normalizer
 */
export function buildCorrectedPitchPointsForSyllable (analysis, features, target, normalizer) {
  if (!features || !features.voiced || !features.span) return null;
  return buildCorrectedPitchPoints(
    analysis,
    { voiced: true, syllables: [features], spans: [features.span] },
    [target],
    normalizer
  );
}
