/*
 * Regression test for the shared calibration flow
 * (docs/single-word/calibration.js), used by BOTH apps.
 *
 * The rules being pinned down here are easy to get subtly wrong and their
 * failure modes are quiet: a pass that lowers the trust-gate bar without
 * actually earning it silently degrades every later verdict, and a pass
 * that never terminates traps the learner. No DOM and no audio — the
 * session deliberately owns sequencing only, which is what makes this
 * testable at all.
 *
 * Run from the project root:
 *   node test_calibration.mjs
 */

import { CalibrationSession, shouldCalibrate, CALIBRATION_WORDS }
  from './docs/single-word/calibration.js';
import { SpeakerNormalizer } from './docs/single-word/features.js';
import { WORDS } from './docs/single-word/words.js';

let failures = 0;
function check (cond, label) {
  if (cond) console.log(`  PASS: ${label}`);
  else { failures++; console.log(`  FAIL: ${label}`); }
}

/** A normalizer that will clear the trust gate: 4 utterances, wide spread. */
function trustedNormalizer () {
  const n = new SpeakerNormalizer();
  // Frames spanning ~14 semitones so rangeSemitones() clears either bar.
  n.add([180, 190, 200, 210, 220, 240, 260, 400], 1);
  n.add([180, 200, 240, 300, 380, 400], 2);
  n.add([170, 190, 230, 290, 370, 410], 3);
  n.add([175, 195, 235, 295, 375, 405], 4);
  return n;
}

/** A normalizer that will NOT clear it: flat, narrow range. */
function flatNormalizer () {
  const n = new SpeakerNormalizer();
  for (const t of [1, 2, 3, 4]) n.add([200, 201, 202, 203], t);
  return n;
}

/* ------------------------------------------------------------------ */

console.log('--- 1. The calibration set is one word per tone ---');
{
  check(CALIBRATION_WORDS.length === 4, `4 prompts (got ${CALIBRATION_WORDS.length})`);
  check(CALIBRATION_WORDS.every(Boolean), 'no prompt is undefined (lookup by tone resolved)');
  check(new Set(CALIBRATION_WORDS.map(w => w.tone)).size === 4,
    'all four tones are covered, which is what satisfies the diversity gate');
  check(new Set(CALIBRATION_WORDS.map(w => w.syllable)).size === 1,
    'all prompts share one base syllable, so only tone varies');
  check(CALIBRATION_WORDS.every(w => WORDS.includes(w)),
    'prompts are the real WORDS entries, so either app can display them directly');
}

console.log('\n--- 2. A completed pass earns the lowered trust bar ---');
{
  const n = trustedNormalizer();
  const before = n.minRangeSemitones;
  const s = new CalibrationSession(n);
  check(s.active, 'session starts active');
  check(s.total === 4 && s.index === 0, 'starts at prompt 0 of 4');
  check(s.progressLabel === 'Word 1 of 4', `progress label reads '${s.progressLabel}'`);

  check(s.accept() === true, 'accept 1 of 4 continues');
  check(s.item === CALIBRATION_WORDS[1], 'the second prompt is now current');
  check(s.progressLabel === 'Word 2 of 4', 'progress label advanced');
  check(s.accept() === true, 'accept 2 of 4 continues');
  check(s.accept() === true, 'accept 3 of 4 continues');
  check(s.accept() === false, 'accept 4 of 4 finishes');

  check(s.active === false, 'session is no longer active');
  check(s.completed === true && s.skipped === false, 'recorded as completed, not skipped');
  check(s.item === null, 'no prompt is current once finished');
  check(before === 6 && n.minRangeSemitones === 3,
    `trust-gate range bar dropped 6 -> 3 ST (got ${n.minRangeSemitones})`);
  check(n.calibrated === true, 'normalizer is flagged calibrated');
}

console.log('\n--- 3. Skipping does NOT lower the bar ---');
{
  const n = trustedNormalizer();
  const s = new CalibrationSession(n);
  s.accept();
  s.skip();
  check(s.active === false, 'skip ends the session');
  check(s.skipped === true && s.completed === false, 'recorded as skipped, not completed');
  check(n.minRangeSemitones === 6,
    `range bar stays at the stricter default (got ${n.minRangeSemitones})`);
  check(n.calibrated === false, 'normalizer is NOT flagged calibrated');
  check(shouldCalibrate(n) === true,
    'a skipped pass leaves shouldCalibrate() true — skipping is "not now", not "done"');
  check(s.accept() === false, 'accept() after skip is inert');
}

console.log('\n--- 4. One extra repeat when the gate still is not satisfied ---');
{
  const n = flatNormalizer();
  check(n.isRegisterTrusted() === false, 'the flat normalizer does not clear the gate');
  const s = new CalibrationSession(n);
  for (let i = 0; i < 3; i++) check(s.accept() === true, `accept ${i + 1} continues`);
  check(s.accept() === true,
    'the 4th accept continues instead of finishing, because the gate is unmet');
  check(s.total === 5, `queue grew by exactly one (total ${s.total})`);
  check(s.extraRoundUsed === true, 'the extra round is marked used');
  check(CALIBRATION_WORDS.some(w => w === s.item),
    'the extra prompt is one of the calibration words');

  check(s.accept() === false, 'the extra repeat finishes the pass');
  check(s.total === 5, 'the queue does not grow a second time');
  check(n.minRangeSemitones === 3,
    'the bar is lowered anyway rather than looping forever on a narrow-range speaker');
}

console.log('\n--- 5. No extra round when the gate is already satisfied ---');
{
  const n = trustedNormalizer();
  const s = new CalibrationSession(n);
  s.accept(); s.accept(); s.accept();
  check(s.accept() === false, 'finishes at 4 with no extra prompt');
  check(s.total === 4, 'queue length unchanged');
  check(s.extraRoundUsed === false, 'no extra round was spent');
}

console.log('\n--- 6. allowExtraRound:false finishes at the queue end ---');
{
  const n = flatNormalizer();
  const s = new CalibrationSession(n, { allowExtraRound: false });
  s.accept(); s.accept(); s.accept();
  check(s.accept() === false, 'finishes at 4 even though the gate is unmet');
  check(s.total === 4, 'no extra prompt was appended');
  check(n.calibrated === true, 'still counts as completed');
}

console.log('\n--- 7. shouldCalibrate() gates re-running a pass ---');
{
  const fresh = new SpeakerNormalizer();
  check(shouldCalibrate(fresh) === true, 'a fresh normalizer should calibrate');
  fresh.markCalibrated();
  check(shouldCalibrate(fresh) === false,
    'an already-calibrated normalizer should not be put through it again');
  check(shouldCalibrate(null) === false, 'a missing normalizer is handled, not thrown on');
}

console.log('\n--- 8. Custom prompt lists and degenerate input ---');
{
  const n = new SpeakerNormalizer();
  const items = [{ tone: 1, pinyin: 'x' }, { tone: 4, pinyin: 'y' }];
  const s = new CalibrationSession(n, { items, allowExtraRound: false });
  check(s.total === 2 && s.item === items[0], 'a host can supply its own prompts');
  s.accept();
  check(s.accept() === false, 'a 2-prompt pass finishes after 2 accepts');

  const empty = new CalibrationSession(new SpeakerNormalizer(), { items: [] });
  check(empty.active === false, 'an empty prompt list yields an inactive session');
  check(empty.item === null, 'no prompt is current');
  check(empty.accept() === false, 'accept() on an inactive session is inert, not a crash');
}

/* ------------------------------------------------------------------ */

console.log('\n' + '='.repeat(40));
console.log(failures === 0 ? 'All checks passed.' : `${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
