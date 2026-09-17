#!/usr/bin/env node
/*
 * build-tone-modes.mjs — fit the accepted realization shapes that tone-match.js
 * scores and viz.js draws, and print them as a paste-ready JS literal.
 *
 * WHY MODES AND NOT A MEAN. `targets.json` gives one mean contour per
 * (syllable, tone). Measured against those bands, only 13% of native T3
 * productions and 29% of native T4s land within ±2 ST of the band they are
 * drawn against (see the table this script prints, and EVALUATION_PLAN.md §0.3).
 * The mean is not a target native speakers hit, because real T3 is bimodal —
 * full dipping third against half-third — and a single curve sits between the
 * modes where nobody actually is. Clustering each tone into K accepted shapes
 * recovers that: LOSO tone identity by nearest-shape geometry goes from 79.8%
 * (K=1) to 82.2% (K=3), against the live rule classifier's 83.0%.
 *
 * WHAT IS FITTED, AND WHAT IS NOT. Only the SHAPE (Legendre c1..c3) and a mean
 * duration per mode. c0 is deliberately not fitted here: the feature cache is
 * built one clip at a time with a fresh SpeakerNormalizer, so each clip is
 * normalized to its own median and its c0 is ~0 by construction — it carries no
 * register information to learn from. tone-match.js takes the register anchor
 * from targets.json / FALLBACK instead, and its bounded vertical shift absorbs
 * the difference. Revisit only if a register-aware cache is ever built (that is
 * a FEATURE_CACHE_VERSION bump and a full re-extraction).
 *
 * CONTAMINATION. Every accuracy and tolerance number printed here is
 * leave-one-speaker-out: shapes are fitted on five speakers and scored on the
 * sixth, so no clip is ever measured against a model that saw it. The emitted
 * literal is then refitted on all six, which is correct for a shipped artifact
 * and is the only number in the output that is not cross-validated.
 *
 * REGIME. Reads either feature cache (see NORMALIZATION_MODES in corpus-eval.mjs):
 *
 *   per-speaker (default, preferred) — c0 is genuine semitones-re-speaker-
 *     register, so the full contour INCLUDING HEIGHT is fitted and the vertical
 *     slack stays bounded. Tone 3 needs this: it is defined by being low, not by
 *     its shape, and in the shape-only regime no tolerance both accepts most
 *     correct T3s and rejects wrong ones (EVALUATION_PLAN.md §0.6).
 *
 *   per-clip — every clip normalized to its own median, so c0 is ~0 and only
 *     c1..c3 can be fitted. Kept because it is the regime an UNCALIBRATED
 *     learner is scored in, and because it is what the historical benchmarks
 *     used.
 *
 * Requires the Tone Perfect feature cache (gitignored, research-licensed):
 *   TONE_PERFECT_NORMALIZATION=per-speaker TONE_PERFECT_JOBS=6 \
 *     node scripts/evaluate-tones.mjs      # builds the cache (~1 h first time)
 *   node scripts/build-tone-modes.mjs
 *   NORMALIZATION=per-clip node scripts/build-tone-modes.mjs   # the other regime
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { FEATURE_CACHE_VERSION } from './lib/corpus-eval.mjs';
import { classify } from '../docs/single-word/classifier.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SPEAKERS = ['FV1', 'FV2', 'FV3', 'MV1', 'MV2', 'MV3'];

/*
 * Candidate counts of accepted realizations per tone. The count is CHOSEN PER
 * TONE by measurement (see chooseK) rather than fixed globally, because the
 * right number differs by tone and the difference is large: at a fixed K=3, T3
 * keeps only 37% of correct native productions, and at K=4 it keeps 62% for the
 * same false-accept budget. A global constant was quietly costing T3 half its
 * coverage.
 *
 * Note this is a selection on the same LOSO metric it reports, so the chosen K
 * is mildly optimistic. The guard against the real hazard — fitting the six
 * speakers rather than the language — is that folds hold out a whole speaker,
 * and that MIN_MODE_SHARE still prunes clusters too small to be a realization.
 */
const K_CANDIDATES = [1, 2, 3, 4];

/* Coverage a larger K must beat the smallest adequate one by before it is worth
 * taking. Every extra realization is another band to explain to a learner and
 * another way to fit six voices instead of a language, and T3's coverage curve
 * is NON-MONOTONIC in K (53% / 27% / 32% / 56%), which is a direct signal that
 * this metric is noisy enough that chasing its maximum is chasing noise. */
const K_PARSIMONY_MARGIN = 0.03;

/* Minimum share of a tone's clips a cluster must hold to be shipped as an
 * ACCEPTED REALIZATION. At K=3 every tone throws a small third cluster that is
 * phonetically uninterpretable — a steep fall for T1 (n=38), an inverted arch
 * for T3 (n=95), a rising T4 (n=225) — i.e. Praat octave and creak tracking
 * failures, not ways people say the tone. Those clusters are useful to an
 * identity model (a mistracked T3 is still a T3, and a sink for it improves
 * nearest-shape identity by ~3pp), but tone-match.js does not do identity:
 * classifier.js does. All tone-match.js does is tell a learner how close they
 * are and draw the band they aim at, and putting a tracking artifact on screen
 * as "a valid way to say tone 3" is precisely the confidently-wrong feedback
 * this pipeline exists to avoid. So they are pruned from the shipped table.
 *
 * 0.15 is a JUDGEMENT CALL, not a measurement, and it is the weakest link in
 * this script. At 0.05 a rising-arch T4 cluster survives (n=225, 9% of T4s) —
 * almost certainly T4s that fall into creak, get their F0 halved by Praat, and
 * read as a late rise. It is not a way anyone says T4. At 0.15 exactly two
 * clusters survive per tone and all eight are phonetically interpretable:
 * level/slightly-arched T1, steeper and shallower T2 rises, full dipping third
 * against half-third, and steeper and shallower T4 falls.
 *
 * The PRINCIPLED filter would be targets.js's own `bandAcceptedAs` — keep a
 * cluster only if the rule classifier identifies its shape as that tone, which
 * is the gate already applied to per-syllable corpus bands. It cannot be used
 * here: that test needs an absolute c0, these clusters have none (see the
 * header), and anchoring them on FALLBACK's c0 rejects the half-third T3 for
 * having an offset its real productions do not have. Switching to it is the
 * first thing a register-aware cache would buy. */
const MIN_MODE_SHARE = 0.15;

/* Sampling resolution for contour comparison. The deviation integral is over
 * normalized time, so this only needs to be fine enough that the max-deviation
 * statistic is stable; 41 points is ~0.05 in t. */
const NT = 41;
const TS = Array.from({ length: NT }, (_, i) => -1 + 2 * i / (NT - 1));

/* Weight on the duration term, in semitone-equivalents per octave of duration
 * error. Duration is a genuine tone cue in this corpus (T4 is the short tone,
 * T3 the long one) and including it is worth +2pp overall, +4pp on T4. */
const DUR_WEIGHT = 1.5;

/* Fraction of native productions an "accepted" band must contain. 0.80 is a
 * judgement call, not a measurement: it is the point where the T1 band stays
 * tight enough to mean something (±0.9 ST) while T3's stops rejecting the
 * majority of real T3s. */
const COVERAGE = 0.80;

/* Floor on the 'good' tolerance, semitones RMS. Native spread alone is the
 * wrong bar for a learner: native T1 is so stable that its 80th percentile is
 * 0.34 ST RMS, which would make the app STRICTER than the rule classifier it
 * replaces — the opposite of the complaint that prompted this work. 1.0 ST is a
 * judgement call meaning roughly "a semitone of wobble is not an error". */
const LEARNER_FLOOR = 1.0;

/* Allowed vertical slack when aligning a production to a reference, semitones.
 * At ±2 ST the closest any canonical tone comes to another is 5.5 ST max /
 * ~3.2 ST RMS, and flat-low to flat-high (T1 vs T3) stays 7.8 ST apart, so the
 * slack cannot convert one tone into another. See EVALUATION_PLAN.md §0.4. */
const MAX_SHIFT = 2.0;

/* Ceiling on how often a band may accept a production of a DIFFERENT tone.
 *
 * This replaces an earlier geometric rule — cap each band at half the distance
 * to the nearest other tone, so bands touch but never overlap. That rule is tidy
 * and was the wrong objective: it is stated in terms of the reference shapes
 * rather than of real productions, and it clamped T3 to a band that rejected
 * 73% of correct native third tones. What actually matters is the tradeoff
 * between accepting correct productions and accepting wrong ones, so that is
 * measured directly and the budget is set here. 5% is a judgement call. */
const MAX_FALSE_ACCEPT = 0.05;

/* How much wider the 'close' band is than 'good'. */
const CLOSE_RATIO = 1.8;

/*
 * Optional cap on how far a 'good' production may stray from the reference at
 * any single point, as a multiple of its tolerance. Infinity disables it.
 *
 * MEASURED AND DECLINED. Setting it to CLOSE_RATIO would make the picture honest
 * in both directions: inside the inner band implies good (which already holds),
 * AND good implies the line never leaves the outer band (which does not — RMS
 * averages, so a line can stray far at one point and still pass, and 27% of
 * correct productions are drawn doing exactly that). The cost is coverage, and
 * it lands almost entirely on the tone that can least afford it:
 *
 *              T1     T2     T3     T4
 *   no cap    100%    97%    68%    91%
 *   cap 1.8   100%    96%    47%    85%
 *
 * Declined because it trades the wrong way. The complaint this work came from
 * was that evaluation is TOO STRICT, and the direction the cap fixes — a line
 * drawn outside the band that is nonetheless marked right — is the generous one
 * nobody objects to. Marking more than half of correct native third tones wrong
 * to tidy up a pleasant surprise is a bad bargain. The band is therefore a
 * SUFFICIENT condition, and the UI must say so rather than implying it is also
 * necessary.
 */
const EXCURSION_CAP = Infinity;

/* Tolerance search grid, semitones RMS. */
const TOL_MIN = 0.25;
const TOL_MAX = 6.0;
const TOL_STEP = 0.01;

function legendreBasis (t) {
  return [1, t, (3 * t * t - 1) / 2, (5 * t * t * t - 3 * t) / 2];
}

/** Sample a Legendre coefficient vector across normalized time. */
function curve (coefs) {
  return TS.map(t => {
    const b = legendreBasis(t);
    let y = 0;
    for (let k = 0; k < 4; k++) y += (coefs[k] || 0) * b[k];
    return y;
  });
}

/**
 * Deviation of contour `a` from reference `b` after the best vertical shift.
 * The shift is the least-squares one (the mean residual), optionally clamped —
 * clamping is what keeps a bounded-slack match from sliding one tone onto
 * another. Returns semitones.
 */
function deviation (a, b, maxShift = Infinity) {
  let d = 0;
  for (let i = 0; i < NT; i++) d += b[i] - a[i];
  d /= NT;
  const shift = Math.max(-maxShift, Math.min(maxShift, d));
  let ss = 0;
  let mx = 0;
  for (let i = 0; i < NT; i++) {
    const e = a[i] + shift - b[i];
    ss += e * e;
    if (Math.abs(e) > mx) mx = Math.abs(e);
  }
  return { shift, rms: Math.sqrt(ss / NT), max: mx };
}

/**
 * k-means over shape vectors, seeded deterministically by spreading the initial
 * centroids along the c2 axis (curvature — the dimension T3's bimodality lives
 * in). Deterministic seeding matters: this output is committed into a source
 * file, so two runs on the same cache must produce the same numbers.
 */
function kmeans (xs, k, iters = 60) {
  const sorted = [...xs].sort((p, q) => p[1] - q[1]);
  let cent = [];
  for (let i = 0; i < k; i++) cent.push(sorted[Math.floor((i + 0.5) * sorted.length / k)].slice());

  let assign = new Array(xs.length).fill(-1);
  for (let it = 0; it < iters; it++) {
    let moved = false;
    for (let n = 0; n < xs.length; n++) {
      let bi = 0;
      let bd = Infinity;
      for (let i = 0; i < k; i++) {
        let d = 0;
        for (let j = 0; j < xs[n].length; j++) d += (xs[n][j] - cent[i][j]) ** 2;
        if (d < bd) { bd = d; bi = i; }
      }
      if (assign[n] !== bi) { assign[n] = bi; moved = true; }
    }
    const sum = cent.map(c => new Array(c.length).fill(0));
    const cnt = new Array(k).fill(0);
    for (let n = 0; n < xs.length; n++) {
      cnt[assign[n]]++;
      for (let j = 0; j < xs[n].length; j++) sum[assign[n]][j] += xs[n][j];
    }
    for (let i = 0; i < k; i++) {
      if (cnt[i] === 0) continue;
      for (let j = 0; j < cent[i].length; j++) cent[i][j] = sum[i][j] / cnt[i];
    }
    if (!moved && it > 0) break;
  }
  return { centroids: cent, assign };
}

/** Drop clusters too small to be a realization rather than an artifact. */
function prune (modes) {
  const out = {};
  for (const tone of [1, 2, 3, 4]) {
    const total = modes[tone].reduce((a, m) => a + m.n, 0);
    const kept = modes[tone].filter(m => m.n >= MIN_MODE_SHARE * total);
    out[tone] = kept.length ? kept : [modes[tone][0]];   // never prune to nothing
  }
  return out;
}

/*
 * Fit K modes per tone.
 *
 * In the per-speaker regime the clustering runs over the FULL coefficient vector
 * c0..c3, so a mode carries its own register height and the emitted references
 * no longer borrow an anchor from targets.json. In the per-clip regime c0 is ~0
 * for every clip, so including it would cluster on noise; only c1..c3 are fitted
 * and c0 is left at 0 for a caller to anchor.
 */
function fitModes (records, kSpec) {
  const out = {};
  const dims = FIT_C0 ? 4 : 3;
  const vec = r => (FIT_C0 ? r.coefs.slice(0, 4) : r.coefs.slice(1, 4));
  for (const tone of [1, 2, 3, 4]) {
    const k = typeof kSpec === 'number' ? kSpec : kSpec[tone];
    const rs = records.filter(r => r.tone === tone);
    const xs = rs.map(vec);
    const { centroids, assign } = k === 1
      ? { centroids: [xs.reduce((a, x) => a.map((v, i) => v + x[i] / xs.length), new Array(dims).fill(0))],
        assign: new Array(xs.length).fill(0) }
      : kmeans(xs, k);

    out[tone] = centroids.map((c, i) => {
      const members = rs.filter((_r, n) => assign[n] === i);
      const logDur = members.length
        ? members.reduce((a, r) => a + Math.log2(r.voicedFrameCount), 0) / members.length
        : Math.log2(110);
      const coefs = FIT_C0 ? c.slice() : [0, ...c];
      return {
        coefs,                          // [c0, c1, c2, c3] (c0 = 0 when not fitted)
        curve: curve(coefs),
        dur: Math.round(2 ** logDur),
        logDur,
        n: members.length
      };
    }).sort((a, b) => b.n - a.n);       // most common realization first
  }
  return out;
}

/** Nearest accepted shape across all tones; returns the winning tone. */
function identify (rec, modes, maxShift) {
  const a = curve(rec.coefs);
  let best = null;
  let bs = Infinity;
  for (const tone of [1, 2, 3, 4]) {
    for (const m of modes[tone]) {
      const d = deviation(a, m.curve, maxShift);
      const s = d.rms + DUR_WEIGHT * Math.abs(Math.log2(rec.voicedFrameCount) - m.logDur);
      if (s < bs) { bs = s; best = tone; }
    }
  }
  return best;
}

/* ------------------------------------------------------------------ */

const NORMALIZATION = process.env.NORMALIZATION || 'per-speaker';
const FIT_C0 = NORMALIZATION === 'per-speaker';
const suffix = FIT_C0 ? '-speaker' : '';
const cache = join(ROOT, '.tone-cache', `features-all-v${FEATURE_CACHE_VERSION}${suffix}.json`);
let parsed;
try {
  parsed = JSON.parse(readFileSync(cache, 'utf8'));
} catch (_e) {
  console.error(`No ${NORMALIZATION} feature cache at ${cache}.`);
  console.error('Build it with:');
  console.error(`  TONE_PERFECT_NORMALIZATION=${NORMALIZATION} TONE_PERFECT_JOBS=6 node scripts/evaluate-tones.mjs`);
  process.exit(1);
}
const recs = parsed.records.filter(r => r.voiced);
console.log(`cache: ${cache}`);
console.log(`  ${recs.length} voiced clips, ${parsed.perTone === 'all' ? 'full corpus' : parsed.perTone + '/tone'}, ` +
  `normalization ${parsed.normalization || 'per-clip'}`);
console.log(`  fitting ${FIT_C0 ? 'c0..c3 (register carried by the modes)' : 'c1..c3 (shape only; c0 anchored by the caller)'}`);
console.log(`  vertical slack ±${FIT_C0 ? MAX_SHIFT.toFixed(1) + ' ST' : '\u221e (register is meaningless in this regime)'}\n`);

/* Slack used for every comparison below. Unbounded in the shape-only regime,
 * mirroring tone-match.js's shiftLimitFor(): with c0 ~ 0 for every clip a
 * bounded shift would charge each production a register error it did not make. */
const SLACK = FIT_C0 ? MAX_SHIFT : Infinity;

/* --- Choose how many accepted realizations each tone needs ---------------- */

const accepted = (ds, tol) => ds.filter(d => isGood(d, tol)).length / ds.length;

/** Would this deviation be accepted as 'good' at tolerance `tol`? */
function isGood (d, tol) {
  return d.rms <= tol && d.max <= EXCURSION_CAP * tol;
}

/** Widest tolerance whose false-accept rate stays inside the budget. */
function budgetTolerance (wrongDevs) {
  let best = TOL_MIN;
  for (let tol = TOL_MIN; tol <= TOL_MAX; tol += TOL_STEP) {
    if (wrongDevs.filter(d => isGood(d, tol)).length / wrongDevs.length > MAX_FALSE_ACCEPT) break;
    best = tol;
  }
  return best;
}

/*
 * How well would `tone` be served by k realizations? LOSO, and self-contained:
 * a tone's coverage depends only on its OWN modes — on how near its correct
 * productions fall to them, and on how near everyone else's do — so each tone's
 * count can be chosen independently of the others.
 */
function evaluateToneK (tone, k) {
  const correct = [];
  const wrong = [];
  for (const held of SPEAKERS) {
    const train = recs.filter(r => r.speaker !== held);
    const test = recs.filter(r => r.speaker === held);
    const modes = prune(fitModes(train, { 1: k, 2: k, 3: k, 4: k }))[tone];
    for (const r of test) {
      const a = curve(r.coefs);
      let best = null;
      for (const m of modes) {
        const d = deviation(a, m.curve, SLACK);
        if (!best || d.rms < best.rms) best = d;
      }
      if (best) (r.tone === tone ? correct : wrong).push(best);
    }
  }
  const tol = budgetTolerance(wrong);
  const good = Math.max(tol, LEARNER_FLOOR);
  return { k, tol, good, coverage: accepted(correct, good), falseAccept: accepted(wrong, good) };
}

console.log('accepted realizations per tone — chosen by coverage at a fixed false-accept budget:');
console.log('       ' + K_CANDIDATES.map(k => `K=${k}`.padStart(11)).join('') + '     chosen');
console.log('       (coverage of correct native productions / tolerance it is measured at)');
const K_BY_TONE = {};
for (const tone of [1, 2, 3, 4]) {
  const results = K_CANDIDATES.map(k => evaluateToneK(tone, k));
  // Smallest K within the parsimony margin of the best coverage.
  const bestCoverage = Math.max(...results.map(r => r.coverage));
  const best = results.find(r => r.coverage >= bestCoverage - K_PARSIMONY_MARGIN);
  K_BY_TONE[tone] = best.k;
  console.log(`  T${tone} ` + results.map(r => `${(100 * r.coverage).toFixed(0)}%/±${r.good.toFixed(1)}`.padStart(11)).join('') +
    `     K=${best.k} (±${best.good.toFixed(2)})`);
}
console.log('');

/* --- LOSO: honest accuracy, and the tolerance distribution ---------------- */

/** Does the (independent) rule classifier agree this clip is its labelled tone? */
function ruleAgrees (r) {
  return classify(r.tone, {
    voiced: true, coefs: r.coefs, offset: r.offset,
    voicedFrameCount: r.voicedFrameCount, registerTrusted: r.registerTrusted
  }).bestTone === r.tone;
}

/* devsByTone[targetTone] = deviations of clips whose TRUE tone is targetTone.
 * falseByTone[targetTone] = deviations of clips of every OTHER tone, measured
 * against targetTone's references — what a band of a given width would wrongly
 * accept. Both are needed to set a tolerance as a tradeoff instead of a guess. */
const devsByTone = { 1: [], 2: [], 3: [], 4: [] };
const falseByTone = { 1: [], 2: [], 3: [], 4: [] };
const conf = { 1: {}, 2: {}, 3: {}, 4: {} };
let correct = 0;
let correctPruned = 0;
for (const held of SPEAKERS) {
  const train = recs.filter(r => r.speaker !== held);
  const test = recs.filter(r => r.speaker === held);
  const modes = fitModes(train, K_BY_TONE);
  const kept = prune(modes);
  for (const r of test) {
    const pred = identify(r, modes, SLACK);
    conf[r.tone][pred] = (conf[r.tone][pred] || 0) + 1;
    if (pred === r.tone) correct++;
    if (identify(r, kept, SLACK) === r.tone) correctPruned++;

    // What each tone's band would wrongly accept, if this clip were offered to
    // it. Mistracked clips are NOT filtered out here: a band that accepts a
    // mistracked T2 as a T3 is still a band that marks a learner right for the
    // wrong thing, so the cost must be counted in full.
    for (const target of [1, 2, 3, 4]) {
      if (target === r.tone) continue;
      let best = null;
      for (const m of kept[target]) {
        const d = deviation(curve(r.coefs), m.curve, SLACK);
        if (!best || d.rms < best.rms) best = d;
      }
      if (best) falseByTone[target].push(best);
    }

    // Tolerance: against the CORRECT tone's nearest SHIPPED shape — "how far
    // from its own target does a real production of this tone sit?" — and only
    // over clips the rule classifier independently agrees are that tone. The
    // corpus contains mistracked clips (the pruned clusters are made of them);
    // letting those set the band would inflate the tolerance with Praat's
    // failures rather than with human variation. Using classifier.js as the
    // filter is not circular: it is a separate model, and it is not what the
    // tolerance is being computed for.
    if (!ruleAgrees(r)) continue;
    const a = curve(r.coefs);
    let bd = null;
    for (const m of kept[r.tone]) {
      const d = deviation(a, m.curve, SLACK);
      if (!bd || d.rms < bd.rms) bd = d;
    }
    devsByTone[r.tone].push(bd);
  }
}

const quantile = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(p * (s.length - 1))];
};
const recall = tone => {
  const row = conf[tone];
  const n = Object.values(row).reduce((a, b) => a + b, 0);
  return (100 * (row[tone] || 0) / n) / 100;
};

/* Live rule classifier on the same clips, for comparison. It is literature-tuned
 * rather than fitted, so a pooled run is directly comparable to a LOSO one. */
let ruleOk = 0;
const ruleRecall = { 1: [0, 0], 2: [0, 0], 3: [0, 0], 4: [0, 0] };
for (const r of recs) {
  const v = classify(r.tone, {
    voiced: true, coefs: r.coefs, offset: r.offset,
    voicedFrameCount: r.voicedFrameCount, registerTrusted: r.registerTrusted
  });
  ruleRecall[r.tone][1]++;
  if (v.bestTone === r.tone) { ruleOk++; ruleRecall[r.tone][0]++; }
}

console.log('tone identity, full corpus:');
console.log(`  rule classifier (literature-tuned, pooled) : ${(100 * ruleOk / recs.length).toFixed(1)}%   ` +
  [1, 2, 3, 4].map(t => `T${t} ${(100 * ruleRecall[t][0] / ruleRecall[t][1]).toFixed(0)}%`).join('  '));
console.log(`  nearest fitted shape (LOSO)                : ${(100 * correct / recs.length).toFixed(1)}%   ` +
  [1, 2, 3, 4].map(t => `T${t} ${(100 * recall(t)).toFixed(0)}%`).join('  '));
console.log(`  nearest SHIPPED shape, artifacts pruned (LOSO): ${(100 * correctPruned / recs.length).toFixed(1)}%`);
console.log('\n  The middle row shows geometry CAN carry identity; it is not what ships.');
console.log('  The rules stay — better at T3 identity, and they write every diagnostic');
console.log('  sentence. Geometry only decides good/close/bad, because geometry is what');
console.log('  the learner is shown. The last row is the sanity check that the pruned');
console.log('  table still describes the language and not just its dominant mode.\n');

/* --- Tolerances as a measured tradeoff ----------------------------------- */

/*
 * Pick the widest band whose false-accept rate stays inside the budget, then
 * floor it at LEARNER_FLOOR. Reports the conflict rather than silently
 * resolving it when the floor itself exceeds the budget: that means the tone
 * cannot be given a learner-sized band without also marking wrong productions
 * right, which is a finding, not a number to round away.
 */
function pickTolerance (correctDevs, wrongDevs) {
  const best = budgetTolerance(wrongDevs);
  const floored = Math.max(best, LEARNER_FLOOR);
  return {
    good: +floored.toFixed(2),
    budgetAllows: +best.toFixed(2),
    conflicts: floored > best + 1e-9,
    falseAcceptAtGood: accepted(wrongDevs, floored),
    correctAtGood: accepted(correctDevs, floored),
    correctAtBudget: accepted(correctDevs, best)
  };
}

console.log('tolerance as a tradeoff, LOSO (RMS semitones).');
console.log(`correct = native productions of the tone; wrong = productions of the other three.`);
console.log(`budget: a band may accept at most ${(100 * MAX_FALSE_ACCEPT).toFixed(0)}% of wrong productions.\n`);
console.log('        native spread p50/p80   budget allows   shipped   correct kept   wrong let in');
const tolerances = {};
for (const tone of [1, 2, 3, 4]) {
  const rm = devsByTone[tone].map(d => d.rms);
  const wrong = falseByTone[tone];
  void rm;

  /* The verdict keys on RMS, not max deviation. Max is a single-frame statistic
   * dominated by the span endpoints, where the Legendre basis is largest and
   * pitch tracking is worst, so it reports tracking failures rather than
   * productions. RMS is also what the identity results above were measured with.
   *
   * It buys the property this whole plan is for: a tube of half-width r drawn
   * around the reference contains only curves whose RMS deviation is <= r, so a
   * line drawn ENTIRELY INSIDE THE BAND is guaranteed to score 'good'.
   * Inside-the-band becomes sufficient, not merely necessary — exactly the
   * failure reported against the current display. */
  const t = pickTolerance(devsByTone[tone], wrong);

  /* 'close' is a pedagogical band — "nearly right" — not a statistical claim,
   * so it is a fixed multiple of 'good' rather than a second percentile. */
  tolerances[tone] = { good: t.good, close: +(t.good * CLOSE_RATIO).toFixed(2), detail: t };

  console.log(`  T${tone}  ${quantile(devsByTone[tone].map(d => d.rms), 0.5).toFixed(2).padStart(10)}/${quantile(devsByTone[tone].map(d => d.rms), 0.8).toFixed(2)}` +
    `${('±' + t.budgetAllows.toFixed(2)).padStart(16)}` +
    `${('±' + t.good.toFixed(2)).padStart(10)}` +
    `${(100 * t.correctAtGood).toFixed(0).padStart(13)}%` +
    `${(100 * t.falseAcceptAtGood).toFixed(1).padStart(13)}%` +
    (t.conflicts ? '   <- FLOOR EXCEEDS BUDGET' : ''));
}

const conflicted = [1, 2, 3, 4].filter(t => tolerances[t].detail.conflicts);
if (conflicted.length) {
  console.log(`\nWARNING: ${conflicted.map(t => 'T' + t).join(', ')} cannot be given a ${LEARNER_FLOOR} ST`);
  console.log('learner band within the false-accept budget. The shipped tolerance honours the');
  console.log('floor and exceeds the budget; the alternative is a band that marks correct');
  console.log('productions wrong. Neither is good — treat it as a signal that these tones');
  console.log('need a cue this geometry does not capture, not as a number to tune.');
}

/* --- Ship: refit on all six speakers ------------------------------------- */

const shipped = prune(fitModes(recs, K_BY_TONE));

console.log('\n/* ---- paste into tone-match.js ---- */');
console.log(`// Generated by scripts/build-tone-modes.mjs on ${new Date().toISOString().slice(0, 10)}`);
console.log(`// from ${recs.length} Tone Perfect clips (cache v${FEATURE_CACHE_VERSION}), ` +
  `K per tone ${[1, 2, 3, 4].map(t => 'T' + t + '=' + K_BY_TONE[t]).join(' ')},`);
console.log(`// clusters under ${(100 * MIN_MODE_SHARE).toFixed(0)}% of a tone pruned as tracking artifacts.`);
console.log(`// LOSO identity by nearest shipped shape: ${(100 * correctPruned / recs.length).toFixed(1)}% ` +
  `(rule classifier ${(100 * ruleOk / recs.length).toFixed(1)}%).`);
console.log(`// Normalization: ${NORMALIZATION}. ${FIT_C0
  ? 'coefs are c0..c3 in semitones re speaker register — references need no external anchor.'
  : 'coefs[0] is 0: shape only, the caller must anchor the height.'}`);
console.log('export const MODES_CARRY_REGISTER = ' + String(FIT_C0) + ';');
console.log('export const TONE_MODES = {');
for (const tone of [1, 2, 3, 4]) {
  console.log(`  ${tone}: {`);
  console.log(`    tolerance: { good: ${tolerances[tone].good}, close: ${tolerances[tone].close} },`);
  console.log('    shapes: [');
  shipped[tone].forEach((m, i) => {
    const cs = m.coefs.map(v => +v.toFixed(3)).join(', ');
    const comma = i < shipped[tone].length - 1 ? ',' : '';
    console.log(`      { coefs: [${cs}], dur: ${m.dur}, n: ${m.n} }${comma}`);
  });
  console.log('    ]');
  console.log(`  }${tone < 4 ? ',' : ''}`);
}
console.log('};');
