/*
 * Speaker-calibration flow, shared by both apps.
 *
 * WHY THIS IS A STATE MACHINE AND NOT A UI COMPONENT
 *
 * Calibration is a sequencing problem — walk one word per tone, watch the
 * register trust gate, decide when to stop — and every part of that is
 * independent of how the prompt is drawn. The single-word app renders it in
 * its practice card; the phrase component renders it inside its own shadow
 * DOM with a different layout entirely. Both drive the identical rules from
 * here, so the two can't drift apart, and the rules are testable without a
 * browser (test_calibration.mjs).
 *
 * WHAT CALIBRATION IS FOR
 *
 * Until SpeakerNormalizer.isRegisterTrusted() passes, the classifier scores
 * SHAPE ONLY — slope, curvature, duration — and ignores register cues (is
 * this high or low in your range). The gate needs >=4 utterances across >=2
 * distinct tones with a real F0 spread. Passive practice eventually gets
 * there, but a learner drilling one word never satisfies the tone-diversity
 * half, and the estimate ends up centered on that one tone's range — which
 * systematically punishes correct productions. Walking one word per tone
 * satisfies the count and diversity axes BY CONSTRUCTION, which is why
 * finishing a pass earns the lower range bar (markCalibrated).
 *
 * WHAT THIS DOES NOT DO
 *
 * It never touches audio and never calls normalizer.add(). The host records
 * an utterance through whatever pipeline it already uses, adds it to the
 * normalizer itself, and then calls accept(). Keeping feature plumbing out
 * of here is what lets the phrase component calibrate with the SINGLE-
 * syllable path (extractFeatures) while scoring phrases with the
 * multi-syllable one (extractUtteranceFeatures).
 *
 * It also does not verify that the learner said the right tone: accept()
 * means "an utterance was captured and added", not "it was correct".
 * Calibration is not graded, deliberately — it is measuring the voice, not
 * judging it, and a learner who cannot yet produce T3 still has a register.
 * The known consequence is that a hum or a wrong tone still advances the
 * pass and seeds the reference under the prompted tone's label.
 */

import { CALIBRATION_WORDS } from './words.js';

export { CALIBRATION_WORDS };

/**
 * True when a calibration pass is worth running for this normalizer. False
 * once one has completed (including a normalizer handed in from another app
 * or a previous page), so nobody re-calibrates an already-calibrated
 * speaker. A SKIPPED pass leaves this true — skipping is "not now", not
 * "done".
 */
export function shouldCalibrate (normalizer) {
  return !!normalizer && !normalizer.calibrated;
}

export class CalibrationSession {
  /**
   * @param {SpeakerNormalizer} normalizer  mutated only via markCalibrated()
   * @param {object} [opts]
   * @param {Array<{tone:number}>} [opts.items] prompts to walk, in order.
   *   Only `.tone` is read here; hosts put whatever else they need to
   *   display (hanzi, pinyin, syllable) on the same objects.
   * @param {boolean} [opts.allowExtraRound=true] allow one extra repeat when
   *   the trust gate still isn't satisfied after the queue is exhausted.
   */
  constructor (normalizer, { items = CALIBRATION_WORDS, allowExtraRound = true } = {}) {
    this.normalizer = normalizer;
    this.queue = items.slice();
    this.pos = 0;
    this.allowExtraRound = allowExtraRound;
    this.extraRoundUsed = false;
    this.active = this.queue.length > 0;
    this.completed = false;      // reached the end and earned markCalibrated()
    this.skipped = false;
  }

  /** Current prompt, or null once the pass is over. */
  get item () { return this.active ? this.queue[this.pos] : null; }

  get index () { return this.pos; }
  get total () { return this.queue.length; }

  /** e.g. "Word 2 of 4" — the queue can grow by one, so total is read live. */
  get progressLabel () {
    return `Word ${Math.min(this.pos + 1, this.total)} of ${this.total}`;
  }

  /**
   * Record that an utterance for the current prompt was captured and added
   * to the normalizer by the host.
   *
   * @returns {boolean} true if calibration continues (a new prompt is now
   *   current), false if the pass just finished. On finishing, the
   *   normalizer has been markCalibrated()'d and `active` is false.
   */
  accept () {
    if (!this.active) return false;
    this.pos += 1;

    if (this.pos < this.queue.length) return true;

    // Queue exhausted. The count and tone-diversity axes are satisfied by
    // construction, but F0 spread isn't — a flat, nervous reading can still
    // fail the gate. Spend one extra repeat on a tone already covered
    // (which keeps the diversity guarantee intact) before giving up and
    // lowering the bar anyway; looping forever on a learner who simply
    // speaks in a narrow range would be worse than an imperfect reference.
    if (this.allowExtraRound && !this.extraRoundUsed &&
        !this.normalizer.isRegisterTrusted()) {
      const extra = this._pickExtraItem();
      if (extra) {
        this.extraRoundUsed = true;
        this.queue.push(extra);
        return true;
      }
    }

    this._finish();
    return false;
  }

  /**
   * Abandon the pass. Deliberately does NOT call markCalibrated(): the
   * learner gets today's passive-accumulation behavior with the stricter
   * default bar, which is a safe no-op path rather than a lowered bar that
   * nothing earned.
   */
  skip () {
    if (!this.active) return;
    this.active = false;
    this.skipped = true;
  }

  _finish () {
    this.normalizer.markCalibrated();
    this.active = false;
    this.completed = true;
  }

  /**
   * A prompt for the extra round: prefer a tone the normalizer has actually
   * heard, so the repeat reinforces the existing estimate rather than
   * introducing a tone the learner may not manage. Falls back to the first
   * queued item.
   */
  _pickExtraItem () {
    const seen = [...(this.normalizer.tonesSeen || [])];
    if (seen.length) {
      const tone = seen[Math.floor(Math.random() * seen.length)];
      const match = this.queue.find(it => it.tone === tone);
      if (match) return match;
    }
    return this.queue[0] || null;
  }
}
