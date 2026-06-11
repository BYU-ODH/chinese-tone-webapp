/*
 * Hand-tuned tone classifier and diagnostic rules.
 *
 * Inputs are features from features.js (Legendre c0..c3, onset, offset,
 * duration, intensity slope, voice-quality scalars). Output is a verdict:
 *   {
 *     verdict: 'good' | 'close' | 'bad' | 'uncertain',
 *     targetScore: 0..1,         // confidence in the target tone
 *     bestTone: 1..4,            // tone that scored highest
 *     bestScore: 0..1,
 *     diagnostic: string|null    // human-readable hint for the learner
 *   }
 *
 * Thresholds are derived from the L2 Mandarin literature (rough native
 * targets in semitones-re-speaker-mean) and will need empirical tuning
 * with real child recordings — see TUNING.md before assuming these are
 * final.
 *
 * Native target sketches (semitones re mean), derived from Xu (1997)-style
 * citation contours mapped onto Legendre-3 fits:
 *   T1 (high level)    c0≈+5,    c1≈0,     c2≈0
 *   T2 (mid rising)    c0≈+1,    c1≈+4,    c2≈+0.5
 *   T3 (low dipping)   c0≈-3,    c1≈-1,    c2≈+3.5
 *   T4 (high falling)  c0≈+1,    c1≈-5,    c2≈0
 */

/** Squash to [0, 1]: 1 when |x - center| <= 0, falling linearly to 0 at width. */
function bell (x, center, width) {
  return Math.max(0, 1 - Math.abs(x - center) / width);
}

/** One-sided ramp: 0 below `low`, linearly up to 1 at `high`, capped. */
function rampUp (x, low, high) {
  if (x <= low) return 0;
  if (x >= high) return 1;
  return (x - low) / (high - low);
}

/**
 * Weighted score: returns sum(score_i * w_i) / sum(w_i), skipping rules
 * where w_i is 0. Lets us conditionally include register-dependent rules.
 */
function weighted (rules) {
  let sum = 0;
  let wsum = 0;
  for (const [score, w] of rules) {
    if (w > 0) { sum += score * w; wsum += w; }
  }
  return wsum > 0 ? sum / wsum : 0;
}

/**
 * Score how well features match each tone (1..4). Returns array of 4 scores.
 *
 * Register-dependent cues (c0, onset, offset) are weighted in only when the
 * speaker reference has stabilized (registerTrusted=true). Until then,
 * scoring is shape-only — slope (c1), curvature (c2), and the higher-order
 * Legendre terms — which is enough to distinguish all four canonical tones.
 */
function scoreTones (f) {
  const [c0, c1, c2 /* , c3 */] = f.coefs;
  const reg = f.registerTrusted ? 1 : 0;

  // T1: high level. Shape: |c1| small, |c2| small. Register: c0 high.
  const t1 = weighted([
    [bell(c1, 0, 2.5),       1.0],
    [bell(c2, 0, 2.5),       0.7],
    [bell(c0, 5, 4),         1.0 * reg]
  ]);

  // T2: rising. Shape: c1 positive. Register: c0 mid.
  const t2 = weighted([
    [rampUp(c1, 1, 4),       1.0],
    [bell(c2, 0.5, 3),       0.3],     // mild concave-up tolerated
    [bell(c0, 1, 4),         0.6 * reg]
  ]);

  // T3: low dipping. Shape: c2 positive (U). Register: c0 low.
  const t3 = weighted([
    [rampUp(c2, 1, 3.5),     1.0],
    [bell(c1, -1, 3),        0.3],
    [rampUp(-c0, 0, 4),      0.7 * reg]
  ]);

  // T4: falling. Shape: c1 strongly negative. Register: c0 mid-high.
  const t4 = weighted([
    [rampUp(-c1, 2, 5),      1.0],
    [bell(c2, 0, 3),         0.3],
    [bell(c0, 1, 4),         0.5 * reg]
  ]);

  return [t1, t2, t3, t4];
}

/**
 * Pick a diagnostic message for a target tone given the features and the
 * computed per-tone scores. Returns a short user-facing string.
 */
function diagnose (target, f, scores) {
  const [c0, c1, c2] = f.coefs;
  const reg = !!f.registerTrusted;

  // Confusion check: did another tone score notably higher?
  const targetIdx = target - 1;
  const targetScore = scores[targetIdx];
  let bestOther = -1;
  let bestOtherScore = 0;
  for (let i = 0; i < 4; i++) {
    if (i !== targetIdx && scores[i] > bestOtherScore) {
      bestOtherScore = scores[i];
      bestOther = i + 1;
    }
  }
  const confusedAs = (bestOtherScore > targetScore + 0.15 && bestOtherScore > 0.55)
    ? bestOther : null;

  if (target === 1) {
    if (Math.abs(c1) > 2.5) return 'Keep tone 1 level — don\'t let it slide up or down.';
    if (confusedAs === 4) return 'That sounded like it was falling — hold the high pitch instead.';
    if (confusedAs === 2) return 'That sounded like it was rising — keep tone 1 flat.';
    if (reg && c0 < 0) return 'Tone 1 sits high — start at the top of your voice.';
    if (reg && c0 < 2) return 'A little higher and steadier.';
    return 'Hold the pitch steady up high.';
  }

  if (target === 2) {
    if (c1 < 0.5) return 'Tone 2 rises — start lower and go up at the end.';
    if (c1 < 2) return 'Make the rise more obvious — go higher at the end.';
    if (confusedAs === 3) return 'Tone 2 rises smoothly without a dip — start mid and go up.';
    if (reg && c0 > 4) return 'Start a bit lower so you have room to rise.';
    return 'Smoother rise from low to high.';
  }

  if (target === 3) {
    if (c2 < 0.3 && c1 > 1.5) {
      return 'That sounded more like tone 2 (rising). Tone 3 dips down first, then rises.';
    }
    if (c2 < 0.3 && c1 < -1.5) {
      return 'That fell straight down. Tone 3 dips low, then comes back up a little.';
    }
    if (c2 < 0.5) return 'Dip down low in the middle, then come back up.';
    if (confusedAs === 2) return 'Tone 3 starts low and dips before rising — make sure you go down first.';
    if (reg && c0 > 1) return 'Start lower — tone 3 lives near the bottom of your voice.';
    return 'A clearer dip in the middle.';
  }

  if (target === 4) {
    if (c1 > -0.5) return 'Tone 4 drops sharply — start high and fall fast.';
    if (c1 > -2) return 'Make the fall more dramatic.';
    if (confusedAs === 1) return 'Tone 4 falls — don\'t hold the high pitch, drop down.';
    if (reg && c0 < 0) return 'Start higher — tone 4 jumps off from up high.';
    return 'A sharper drop from high to low.';
  }

  return 'Try again, watching the target shape.';
}

/**
 * Classify a recording against a target tone. Returns the verdict struct.
 */
export function classify (target, features) {
  if (!features.voiced) {
    return {
      verdict: 'uncertain',
      targetScore: 0,
      bestTone: null,
      bestScore: 0,
      scores: [0, 0, 0, 0],
      diagnostic: null,
      reason: features.reason
    };
  }

  const scores = scoreTones(features);
  const targetScore = scores[target - 1];

  let bestTone = 1;
  let bestScore = scores[0];
  for (let i = 1; i < 4; i++) {
    if (scores[i] > bestScore) {
      bestScore = scores[i];
      bestTone = i + 1;
    }
  }

  let verdict;
  if (targetScore >= 0.72 && bestTone === target) verdict = 'good';
  else if (targetScore >= 0.50) verdict = 'close';
  else verdict = 'bad';

  const diagnostic = (verdict === 'good')
    ? null
    : diagnose(target, features, scores);

  return { verdict, targetScore, bestTone, bestScore, scores, diagnostic };
}
