/*
 * Regression test for utterance.js's scoreUtterance() — the Stage 2 seam where
 * the learner-facing verdict moved from classifier.js's rules to tone-match.js's
 * geometry, so that the mark and the drawn band come from one computation.
 *
 * No Praat/WASM needed: synthetic feature structs throughout, as in
 * test_utterance.mjs.
 *
 * Run from the project root:
 *   node test_score_utterance.mjs
 */

import { scoreUtterance } from './docs/single-word/utterance.js';
import { buildReferences, matchSyllable } from './docs/single-word/tone-match.js';

let failures = 0;
function check (cond, msg) {
  if (cond) { console.log(`  ok   ${msg}`); } else { failures++; console.log(`  FAIL ${msg}`); }
}
function section (name) { console.log(`\n${name}`); }

/** A synthetic feature struct fitting `coefs`, in the calibrated regime. */
function feats (coefs, dur = 110) {
  return {
    voiced: true,
    coefs,
    voicedFrameCount: dur,
    offset: coefs.reduce((a, b) => a + b, 0),
    registerTrusted: true,
    referenceFrames: [200, 205, 210]
  };
}

/** Features that reproduce a reference exactly. */
function onTarget (tone, refIndex = 0) {
  const ref = buildReferences(tone)[refIndex];
  return feats(ref.coefs, ref.dur);
}

/* ------------------------------------------------------------------ */
section('the verdict is geometry, and it is the geometry that gets drawn');

{
  const syllables = [onTarget(1), onTarget(4)];
  const { verdicts, matches } = scoreUtterance(syllables, [1, 4]);
  check(verdicts.every(v => v.verdict === 'good'),
    'two on-target syllables both score good');
  check(matches.every((m, i) => m.ref.tone === [1, 4][i]),
    'each match reports the reference it was scored against');
  check(verdicts.every(v => v.diagnostic === null),
    'a good syllable carries no diagnostic');
  // The number the canvas thresholds on and the number the verdict uses are one.
  check(matches.every(m => m.rms <= m.ref.tolerance.good),
    'every good verdict has rms within the tolerance its band is drawn at');
}

{
  // A verdict must follow the geometry even where the old rule classifier,
  // which also weighed duration, would have disagreed.
  const ref = buildReferences(4)[0];
  const veryLong = feats(ref.coefs, ref.dur * 4);
  const { verdicts } = scoreUtterance([veryLong], [4]);
  check(verdicts[0].verdict === 'good',
    'a perfectly shaped T4 held four times too long is still good — duration is not scored');
  check(verdicts[0].durationOk === false,
    'but durationOk is false, so a caller can surface it as a separate hint');
}

/* ------------------------------------------------------------------ */
section('the aim-point swaps to the realization actually matched');

{
  // T3 carries two accepted realizations. A learner producing either is correct,
  // and must be told WHICH one they produced so the canvas can redraw to it.
  const refs = buildReferences(3);
  check(refs.length >= 2, `T3 offers ${refs.length} realizations to match against`);

  // Compared by content, not identity: scoreUtterance builds its own reference
  // objects, and what matters is WHICH realization was chosen.
  const same = (a, b) => a.coefs.every((v, k) => Math.abs(v - b.coefs[k]) < 1e-9);
  refs.forEach((ref, i) => {
    const { verdicts, matches } = scoreUtterance([feats(ref.coefs, ref.dur)], [3]);
    check(verdicts[0].verdict === 'good', `producing T3 realization ${i} scores good`);
    check(same(matches[0].ref, ref),
      `...and the match points at realization ${i}, not at the dominant one`);
    check(matches[0].refIndex === i, `...reported as refIndex ${i}, which is what the canvas redraws to`);
  });
}

/* ------------------------------------------------------------------ */
section('sandhi-optional positions are decided by the same geometry');

{
  // Where a position accepts T3 or T2, whichever the learner produced should win,
  // and matchedTone should say which — with no separate rule to keep in sync.
  const t2 = buildReferences(2)[0];
  const t3 = buildReferences(3)[0];
  const accepted = [[3, 2]];

  const asT2 = scoreUtterance([feats(t2.coefs, t2.dur)], [3], accepted);
  check(asT2.verdicts[0].verdict === 'good' && asT2.verdicts[0].matchedTone === 2,
    'producing the T2 alternative at an optional position is good, matchedTone 2');

  const asT3 = scoreUtterance([feats(t3.coefs, t3.dur)], [3], accepted);
  check(asT3.verdicts[0].verdict === 'good' && asT3.verdicts[0].matchedTone === 3,
    'producing the T3 form at the same position is good, matchedTone 3');

  // Without the option, the T2 production must NOT be credited.
  const strict = scoreUtterance([feats(t2.coefs, t2.dur)], [3]);
  check(strict.verdicts[0].verdict !== 'good',
    'the same T2 production against a plain T3 target is not good');
}

/* ------------------------------------------------------------------ */
section('neutral and unvoiced positions');

{
  const { verdicts, matches } = scoreUtterance([onTarget(4), feats([0, 0, 0, 0])], [4, 0]);
  check(verdicts[1].verdict === 'neutral' && verdicts[1].matchedTone === 0,
    'a neutral position is reported neutral and never scored');
  check(matches[1] === null, 'and has no match, so nothing is drawn for it');
  check(verdicts[0].verdict === 'good', 'the scored syllable beside it is unaffected');
}

{
  const { verdicts, matches } = scoreUtterance(
    [{ voiced: false, reason: 'no-voice' }], [2]);
  check(verdicts[0].verdict === 'uncertain' && verdicts[0].reason === 'no-voice',
    'an unvoiced syllable is uncertain, carrying its reason');
  check(matches[0] === null, 'and has no match');
}

/* ------------------------------------------------------------------ */
section('one register shift for the whole utterance');

{
  const OFF = 1.5;
  const a = buildReferences(1)[0];
  const b = buildReferences(2)[0];
  const low = r => feats([r.coefs[0] - OFF, r.coefs[1], r.coefs[2], r.coefs[3]], r.dur);
  const { shift, verdicts, matches } = scoreUtterance([low(a), low(b)], [1, 2]);
  check(Math.abs(shift - OFF) < 0.25, `one shift of ${shift.toFixed(2)} ST covers the utterance`);
  check(verdicts.every(v => v.verdict === 'good'),
    'a learner uniformly low across the phrase is still right');
  check(matches.every(m => m.shift === shift),
    'and every syllable is judged at that same shift, preserving relative height');
}

{
  // Flattening every syllable onto one pitch must not be rescued by the shift.
  const flat = [feats([0, 0, 0, 0], 110), feats([0, 0, 0, 0], 110)];
  const { verdicts } = scoreUtterance(flat, [1, 3]);
  check(verdicts.filter(v => v.verdict === 'good').length <= 1,
    'saying a T1+T3 phrase on one flat pitch cannot score good on both');
}

/* ------------------------------------------------------------------ */
section('classify() still reports its own opinion, for the record');

{
  const { verdicts } = scoreUtterance([onTarget(1)], [1]);
  check(verdicts[0].bestTone !== null && Array.isArray(verdicts[0].scores),
    'the rule classifier\'s identity and scores are carried through to the payload');
  check(verdicts[0].verdict === 'good',
    'but they do not decide the verdict — geometry does');
}

/* ------------------------------------------------------------------ */
section('scoreUtterance agrees with matchSyllable used directly');

{
  const f = onTarget(2);
  const direct = matchSyllable(f, buildReferences(2), { shift: 0 });
  const viaUtterance = scoreUtterance([f], [2]).matches[0];
  check(Math.abs(direct.rms - viaUtterance.rms) < 1e-9,
    'the same syllable measured either way gives the same deviation');
}

/* ------------------------------------------------------------------ */

console.log('\n' + '='.repeat(40));
console.log(failures === 0 ? 'All checks passed.' : `${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
