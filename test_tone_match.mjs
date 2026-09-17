/*
 * Regression test for tone-match.js.
 *
 * No Praat/WASM needed: every input is a synthetic feature struct, the same way
 * test_utterance.mjs and test_normalizer.mjs synthesize theirs.
 *
 * The load-bearing check is THE GUARANTEE — a contour drawn entirely inside the
 * band must score 'good'. That is the property the display/evaluation redesign
 * exists to establish (EVALUATION_PLAN.md), and it is the one that will quietly
 * break first if anyone retunes a tolerance without moving the band with it.
 *
 * Run from the project root:
 *   node test_tone_match.mjs
 */

import {
  TONE_MODES, MODES_CARRY_REGISTER, MAX_SHIFT_ST, SAMPLES, sampleCoefs, deviation,
  buildReferences, matchSyllable, matchUtterance, bandFor
} from './docs/single-word/tone-match.js';
import { FALLBACK } from './docs/single-word/targets.js';

let failures = 0;
function check (cond, msg) {
  if (cond) { console.log(`  ok   ${msg}`); } else { failures++; console.log(`  FAIL ${msg}`); }
}
function section (name) { console.log(`\n${name}`); }

/** A synthetic feature struct that fits `coefs` with `dur` voiced frames. */
function feats (coefs, dur = 110) {
  return { voiced: true, coefs, voicedFrameCount: dur, offset: coefs.reduce((a, b) => a + b, 0) };
}

/* ------------------------------------------------------------------ */
section('references');

for (const tone of [1, 2, 3, 4]) {
  const refs = buildReferences(tone, FALLBACK[tone]);
  // How many realizations a tone needs is measured, not assumed — once register
  // was available T1, T2 and T4 each collapsed to one shape and only T3 kept two.
  check(refs.length >= 1, `T${tone} has ${refs.length} accepted realization(s)`);
  check(refs.every(r => r.curve.length === SAMPLES), `T${tone} curves sampled at ${SAMPLES} points`);
  // Where the register anchor comes from depends on how the modes were fitted.
  if (MODES_CARRY_REGISTER) {
    check(refs.every(r => r.coefs[0] === TONE_MODES[tone].shapes[refs.indexOf(r)].coefs[0]),
      `T${tone} references carry their own fitted register height`);
  } else {
    check(refs.every(r => r.coefs[0] === FALLBACK[tone].coefs[0]),
      `T${tone} references take their register anchor from the target`);
  }
}

check(buildReferences(3).length >= 2,
  'T3 keeps more than one realization — the dipping third and the half-third');
check(buildReferences(0).length === 0, 'neutral tone (0) yields no references to draw or score');
check(buildReferences(9).length === 0, 'an out-of-range tone yields no references');

if (!MODES_CARRY_REGISTER) {
  // The anchor must actually move the band, or register feedback is impossible.
  const low = buildReferences(1, { coefs: [-4, 0, 0, 0] })[0];
  const high = buildReferences(1, { coefs: [6, 0, 0, 0] })[0];
  check(Math.abs((high.curve[0] - low.curve[0]) - 10) < 1e-9,
    'a 10 ST difference in target height moves the reference curve by 10 ST');
} else {
  // Register-carrying modes must actually differ in height across tones, or the
  // per-speaker extraction did not deliver what it was built for.
  const h = t => buildReferences(t)[0].coefs[0];
  check(h(1) > h(3) + 2,
    `the fitted T1 reference sits above T3 (${h(1).toFixed(2)} vs ${h(3).toFixed(2)} ST)`);
}

/* ------------------------------------------------------------------ */
section('THE GUARANTEE: inside the band implies good');

/*
 * Sweep contours that lie entirely within the good tube — deviations built from
 * Legendre offsets, rejected unless every sampled point is inside — and require
 * every one to score 'good'. This is the sufficiency direction that today's
 * fixed 32-pixel band does not have.
 */
for (const tone of [1, 2, 3, 4]) {
  const refs = buildReferences(tone, FALLBACK[tone]);
  const ref = refs[0];
  const tol = ref.tolerance.good;
  let tested = 0;
  let bad = 0;
  const step = tol / 2;
  for (let d0 = -tol; d0 <= tol; d0 += step) {
    for (let d1 = -tol; d1 <= tol; d1 += step) {
      for (let d2 = -tol; d2 <= tol; d2 += step) {
        const coefs = [ref.coefs[0] + d0, ref.coefs[1] + d1, ref.coefs[2] + d2, ref.coefs[3]];
        const curve = sampleCoefs(coefs);
        // inside the tube at every sampled point?
        let inside = true;
        for (let i = 0; i < SAMPLES; i++) {
          if (Math.abs(curve[i] - ref.curve[i]) > tol + 1e-9) { inside = false; break; }
        }
        if (!inside) continue;
        tested++;
        const m = matchSyllable(feats(coefs, ref.dur), refs, { shift: 0 });
        if (!m || m.verdict !== 'good') bad++;
      }
    }
  }
  check(tested > 0 && bad === 0,
    `T${tone}: all ${tested} contours drawn inside the ±${tol} ST band score 'good' (${bad} did not)`);
}

/* ------------------------------------------------------------------ */
section('bounded shift: tolerant of register, not of the wrong tone');

{
  const refs = buildReferences(1, FALLBACK[1]);
  const onTarget = refs[0].coefs;
  for (const off of [0.5, 1.0, 2.0]) {
    const shifted = [onTarget[0] - off, onTarget[1], onTarget[2], onTarget[3]];
    const m = matchSyllable(feats(shifted, refs[0].dur), refs);
    check(m.verdict === 'good',
      `a perfectly shaped T1 sung ${off} ST low still scores 'good' (shift ${m.shift.toFixed(2)})`);
  }
  const wayLow = [onTarget[0] - 6, onTarget[1], onTarget[2], onTarget[3]];
  const m = matchSyllable(feats(wayLow, refs[0].dur), refs);
  check(m.shiftClamped, 'a 6 ST register error reports shiftClamped');
  check(Math.abs(m.shift) <= MAX_SHIFT_ST + 1e-9, `the shift never exceeds ±${MAX_SHIFT_ST} ST`);
  check(m.verdict !== 'good', 'a 6 ST register error is not forgiven into "good"');
}

{
  // The guard the whole design turns on: a flat LOW tone must never be
  // accepted as the flat HIGH tone, however much slack the matcher is given.
  const t1refs = buildReferences(1, FALLBACK[1]);
  const flatLow = [FALLBACK[3].coefs[0], 0, 0, 0];      // level, at T3's height
  const m = matchSyllable(feats(flatLow, 130), t1refs);
  check(m.verdict === 'bad',
    `a flat low tone scored against T1 is 'bad' (rms ${m.rms.toFixed(2)}, shift ${m.shift.toFixed(2)})`);
}

{
  // Bands must not overlap: no contour may be 'good' for two tones at once.
  let overlaps = 0;
  for (const a of [1, 2, 3, 4]) {
    const refsA = buildReferences(a, FALLBACK[a]);
    for (const ra of refsA) {
      for (const b of [1, 2, 3, 4]) {
        if (b === a) continue;
        const m = matchSyllable(feats(ra.coefs, ra.dur), buildReferences(b, FALLBACK[b]));
        if (m && m.verdict === 'good') overlaps++;
      }
    }
  }
  check(overlaps === 0, `no tone's reference shape scores 'good' against another tone (${overlaps} overlaps)`);
}

/* ------------------------------------------------------------------ */
section('untrusted register: shape-only, as classifier.js and viz.js already are');

{
  /*
   * Before calibration, features.js normalizes a contour to the speaker's own
   * median, so c0 is ~0 for every tone. Scoring that against a reference
   * anchored at +5 ST must not charge the speaker a register error they did not
   * make. This regression marked 100% of native T1 productions 'bad'.
   */
  const refs = buildReferences(1, FALLBACK[1]);
  const selfNormalized = { ...feats([0, ...refs[0].coefs.slice(1)], refs[0].dur), registerTrusted: false };
  const m = matchSyllable(selfNormalized, refs);
  check(m.verdict === 'good',
    `a correctly shaped T1 from an uncalibrated speaker scores good (rms ${m.rms.toFixed(2)}, shift ${m.shift.toFixed(2)})`);
  check(!m.shiftClamped, 'and is not reported as a clamped register error');

  // Measured against the reference's OWN height rather than a hardcoded gap, so
  // this keeps testing the intent when the fitted modes move.
  const gap = refs[0].coefs[0] - (MAX_SHIFT_ST + refs[0].tolerance.good + 1);
  const wayLow = { ...feats([gap, ...refs[0].coefs.slice(1)], refs[0].dur), registerTrusted: true };
  check(matchSyllable(wayLow, refs).verdict !== 'good',
    'the same shape from a CALIBRATED speaker, sung far below their register, is not good');
}

{
  // The shared shift must go unbounded for the whole utterance, not per syllable.
  const tones = [1, 4];
  const refs = tones.map(t => buildReferences(t, FALLBACK[t]));
  const sylls = tones.map((t, i) => {
    const c = refs[i][0].coefs;
    return { ...feats([c[0] - 5, c[1], c[2], c[3]], refs[i][0].dur), registerTrusted: false };
  });
  const res = matchUtterance(sylls, refs);
  check(Math.abs(res.shift - 5) < 0.5, `uncalibrated utterance recovers the full ${res.shift.toFixed(1)} ST offset`);
  check(res.matches.every(m => m && m.verdict === 'good'), 'and both syllables score good');
}

/* ------------------------------------------------------------------ */
section('accepted realizations');

{
  // T3's half-third must be accepted as T3, not only the full dipping third.
  const refs = buildReferences(3, FALLBACK[3]);
  const halfThird = refs.find(r => r.coefs[1] < -2);
  check(!!halfThird, 'T3 carries a falling half-third realization alongside the dip');
  const m = matchSyllable(feats(halfThird.coefs, halfThird.dur), refs);
  check(m.verdict === 'good', 'producing the half-third scores good against T3');
  check(m.ref === halfThird, 'the match reports WHICH realization was matched, for display');
}

/* ------------------------------------------------------------------ */
section('duration is reported, never silently scored');

{
  const refs = buildReferences(4, FALLBACK[4]);
  const ref = refs[0];
  const short = matchSyllable(feats(ref.coefs, ref.dur), refs);
  const long = matchSyllable(feats(ref.coefs, ref.dur * 3), refs);
  check(short.verdict === 'good' && long.verdict === 'good',
    'a perfectly shaped T4 scores good whether short or long — duration does not gate the verdict');
  check(long.durationRatio > 2.5 && long.durationOk === false,
    `the over-long one is flagged for the caller to surface (ratio ${long.durationRatio.toFixed(1)})`);
  check(short.durationOk === true, 'a normal-length production is flagged ok');
}

/* ------------------------------------------------------------------ */
section('unvoiced and neutral positions');

check(matchSyllable({ voiced: false }, buildReferences(1, FALLBACK[1])) === null,
  'an unvoiced syllable yields no match rather than a verdict');
check(matchSyllable(feats([0, 0, 0, 0]), []) === null,
  'a position with no references (neutral tone) yields no match');

/* ------------------------------------------------------------------ */
section('utterance-wide shift');

{
  // Two syllables, both sung 1.5 ST low: one shared shift should rescue both.
  const OFF = 1.5;
  const tones = [1, 4];
  const refs = tones.map(t => buildReferences(t, FALLBACK[t]));
  const sylls = tones.map((t, i) => {
    const c = refs[i][0].coefs;
    return feats([c[0] - OFF, c[1], c[2], c[3]], refs[i][0].dur);
  });
  const res = matchUtterance(sylls, refs);
  check(Math.abs(res.shift - OFF) < 0.2, `one shift of ${res.shift.toFixed(2)} ST recovered for the whole utterance`);
  check(res.matches.every(m => m && m.verdict === 'good'), 'both syllables score good under the shared shift');
  check(res.matches.every(m => m.shift === res.shift), 'every syllable is judged at the SAME register');
}

{
  // Relative height must survive: a learner who flattens every syllable onto one
  // pitch must not be rescued by the shared shift.
  const tones = [1, 3];
  const refs = tones.map(t => buildReferences(t, FALLBACK[t]));
  const flat = tones.map(() => feats([2, 0, 0, 0], 110));
  const res = matchUtterance(flat, refs);
  const goods = res.matches.filter(m => m && m.verdict === 'good').length;
  check(goods <= 1, `saying a T1+T3 phrase on one flat pitch cannot score good on both (${goods} good)`);
}

{
  const res = matchUtterance([{ voiced: false }], [buildReferences(1, FALLBACK[1])]);
  check(res.shift === 0 && res.matches[0] === null,
    'an utterance with nothing voiced yields no shift and no matches');
}

/* ------------------------------------------------------------------ */
section('deviation primitive');

{
  const a = sampleCoefs([0, 1, 0, 0]);
  const d = deviation(a, a);
  check(Math.abs(d.rms) < 1e-9 && Math.abs(d.shift) < 1e-9, 'a contour matched to itself has zero deviation');

  const up = sampleCoefs([3, 1, 0, 0]);
  const d2 = deviation(a, up, MAX_SHIFT_ST);
  check(Math.abs(d2.shift - 2) < 1e-9 && d2.clamped, 'a 3 ST offset clamps to the 2 ST limit and says so');
  check(Math.abs(d2.rms - 1) < 1e-6, 'the residual after clamping is the unforgiven 1 ST');

  const d3 = deviation(a, up, 0);
  check(d3.shift === 0 && Math.abs(d3.rms - 3) < 1e-6, 'maxShift 0 compares at absolute register');
}

/* ------------------------------------------------------------------ */
section('band is what the verdict uses');

for (const tone of [1, 2, 3, 4]) {
  const ref = buildReferences(tone, FALLBACK[tone])[0];
  const band = bandFor(ref);
  check(band.good === TONE_MODES[tone].tolerance.good && band.curve === ref.curve,
    `T${tone}'s drawn band radius is the same number the verdict thresholds on`);
}

/* ------------------------------------------------------------------ */

console.log('\n' + '='.repeat(40));
console.log(failures === 0 ? 'All checks passed.' : `${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
