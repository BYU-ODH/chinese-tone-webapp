/*
 * Multi-utterance session regression test.
 *
 * test_pipeline.mjs covers the single-utterance path (fresh normalizer,
 * shape-only scoring). This test covers what it cannot: the trajectory
 * of scores across a session as the SpeakerNormalizer accumulates data.
 * It guards against the score-degradation bug where the speaker
 * reference (formerly the all-time min/max midpoint) drifted with every
 * utterance, so identical correct productions scored worse and worse —
 * and one creaky T3 could poison the rest of the session.
 *
 * No Praat/WASM needed: extractFeatures() consumes a plain analysis
 * struct, so we synthesize pitch/intensity frames directly.
 *
 * Run from the project root:
 *   node test_normalizer.mjs
 */

import { extractFeatures, SpeakerNormalizer } from './docs/single-word/features.js';
import { classify } from './docs/single-word/classifier.js';

const DX = 0.005;   // matches the Praat script's 5 ms time step

/** Build an analysis struct for a 0.4 s utterance with F0 = f0fn(u), u in 0..1. */
function makeAnalysis (f0fn, dur = 0.4) {
  const n = Math.round(dur / DX);
  const pv = [];
  const iv = [];
  for (let i = 0; i < n; i++) {
    const u = i / (n - 1);
    pv.push(f0fn(u));
    // Loud core with a soft tail-off over the last 20%, like real speech.
    iv.push(70 - 25 * Math.max(0, (u - 0.8) / 0.2));
  }
  return {
    duration: dur,
    pitch: { n, dx: DX, x1: DX / 2, values: pv },
    intensity: { n, dx: DX, x1: DX / 2, values: iv },
    hnrMean: 15,
    jitter: 0.01
  };
}

/* Speaker with mid-register M; tone shapes in semitones re M, Xu-style,
 * with a small onset glide on T1 as real speakers produce. */
const M = 210;
const st = (s) => M * Math.pow(2, s / 12);
const TONES = {
  1: (u) => st(u < 0.15 ? 2.5 + 2.5 * (u / 0.15) : 5),
  2: (u) => st(-1 + 6 * u),
  3: (u) => st(-1 - 6.5 * (1 - Math.pow(2 * u - 1, 2))),
  4: (u) => st(5 - 11 * Math.pow(u, 0.8))
};

/* A correct T3 whose middle drops an extra octave-ish step — mimics
 * Praat halving F0 in a creaky dip. Used to verify one artifact-laden
 * utterance cannot poison the session reference. */
const T3_CREAKY = (u) => {
  const base = -1 - 6.5 * (1 - Math.pow(2 * u - 1, 2));
  return st(u > 0.35 && u < 0.65 ? base - 7 : base);
};

/* A correct T1 with an excited high onset spike (kid voice). */
const T1_SPIKE = (u) => st(u < 0.2 ? 9 - 4 * (u / 0.2) : 5);

/** Run one utterance through the pipeline exactly as app.js does. */
function utter (norm, tone, f0fn = TONES[tone]) {
  const features = extractFeatures(makeAnalysis(f0fn), norm);
  norm.add(features.referenceFrames, tone);
  return { features, verdict: classify(tone, features) };
}

let failures = 0;
function check (cond, label) {
  if (cond) {
    console.log(`  PASS: ${label}`);
  } else {
    failures++;
    console.log(`  FAIL: ${label}`);
  }
}

/* ------------------------------------------------------------------ */

console.log('--- 1. First utterance of a session classifies correctly ---');
for (const tone of [1, 2, 3, 4]) {
  const { verdict } = utter(new SpeakerNormalizer(), tone);
  check(verdict.verdict === 'good' && verdict.bestTone === tone,
    `fresh session T${tone}: good, best=T${tone} ` +
    `(got ${verdict.verdict}, best=T${verdict.bestTone}, score=${verdict.targetScore.toFixed(2)})`);
}

console.log('\n--- 2. Drilling one word x8 must not degrade ---');
for (const tone of [1, 2, 3, 4]) {
  const norm = new SpeakerNormalizer();
  const scores = [];
  let allGood = true;
  for (let i = 0; i < 8; i++) {
    const { verdict } = utter(norm, tone);
    scores.push(verdict.targetScore);
    if (verdict.verdict !== 'good') allGood = false;
  }
  const drift = Math.abs(scores[scores.length - 1] - scores[0]);
  check(allGood, `drill T${tone}: all 8 utterances 'good' ` +
    `(scores ${scores[0].toFixed(2)} … ${scores[scores.length - 1].toFixed(2)})`);
  check(drift <= 0.06, `drill T${tone}: last-vs-first drift ${drift.toFixed(3)} <= 0.06`);
  check(!norm.isRegisterTrusted(),
    `drill T${tone}: single-tone drilling never trusts the register`);
}

console.log('\n--- 3. Cycling all tones x4: stable scores, register earns trust ---');
{
  const norm = new SpeakerNormalizer();
  const byTone = { 1: [], 2: [], 3: [], 4: [] };
  let allGood = true;
  for (let round = 0; round < 4; round++) {
    for (const tone of [1, 2, 3, 4]) {
      const { verdict } = utter(norm, tone);
      byTone[tone].push(verdict.targetScore);
      if (verdict.verdict !== 'good') allGood = false;
    }
  }
  check(allGood, 'cycling: every utterance scores \'good\'');
  check(norm.isRegisterTrusted(), 'cycling: register trusted by session end');
  // Round 1 is shape-only; trust kicks in during round 2 and may step the
  // score once as the c0 register rule starts counting (that step must not
  // break 'good' — asserted above). From then on, identical productions
  // must score identically: compare round 2 vs round 4.
  for (const tone of [1, 2, 3, 4]) {
    const s = byTone[tone];
    const drift = Math.abs(s[1] - s[s.length - 1]);
    check(drift <= 0.03,
      `cycling T${tone}: stable once trusted, round-2 vs round-4 drift ` +
      `${drift.toFixed(3)} <= 0.03 (${s.map(x => x.toFixed(2)).join(' → ')})`);
  }
}

console.log('\n--- 4. One artifact-laden utterance must not poison the session ---');
{
  const norm = new SpeakerNormalizer();
  // Establish a trusted reference over two clean rounds.
  const before = {};
  for (let round = 0; round < 2; round++) {
    for (const tone of [1, 2, 3, 4]) before[tone] = utter(norm, tone).verdict.targetScore;
  }
  // Inject a creaky T3 and a spiky T1 (both correct productions).
  utter(norm, 3, T3_CREAKY);
  utter(norm, 1, T1_SPIKE);
  // Clean round afterwards: scores must hold.
  for (const tone of [1, 2, 3, 4]) {
    const { verdict } = utter(norm, tone);
    const drop = before[tone] - verdict.targetScore;
    check(verdict.verdict === 'good' && drop <= 0.08,
      `post-artifact T${tone}: still 'good', drop ${drop.toFixed(3)} <= 0.08 ` +
      `(${before[tone].toFixed(2)} → ${verdict.targetScore.toFixed(2)})`);
  }
}

console.log('\n--- 5. Safety valve: implausible c0 falls back to shape-only ---');
{
  const norm = new SpeakerNormalizer();
  for (let round = 0; round < 2; round++) {
    for (const tone of [1, 2, 3, 4]) utter(norm, tone);
  }
  check(norm.isRegisterTrusted(), 'reference is trusted before the bad utterance');
  // An utterance tracked an octave+ above the speaker's register
  // (octave-doubling error): must be scored shape-only, not punished.
  const high = extractFeatures(makeAnalysis((u) => st(18)), norm);
  check(high.voiced && high.registerTrusted === false,
    `octave-error utterance scored shape-only (c0=${high.coefs[0].toFixed(1)} ST)`);
}

/* ------------------------------------------------------------------ */

console.log('\n' + '='.repeat(40));
console.log(failures === 0 ? 'All checks passed.' : `${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
