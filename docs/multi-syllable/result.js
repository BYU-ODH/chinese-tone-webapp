/*
 * Scoring/result helpers for the multi-syllable trainer.
 *
 * Deliberately separate from tone-phrase-trainer.js: everything here is
 * pure, DOM-free, and therefore testable in Node (test_phrases.mjs does
 * exactly that), whereas importing the component module in Node fails on
 * `HTMLElement`. It is also the half a host app is most likely to want on
 * its own — e.g. to re-derive an aggregate from a stored attempt payload
 * without instantiating the widget.
 */

export const VERDICT_LABEL = {
  good: 'Nice!',
  close: 'Almost',
  bad: 'Try again',
  uncertain: 'Not heard',
  neutral: 'light'
};

export const UNCERTAIN_REASON_TEXT = {
  'no-voice': "I didn't hear your voice clearly. Try again, a bit louder.",
  'too-short-voiced': 'Hold the button a little longer while you speak.',
  'low-hnr': 'Try again — too much background noise, or too quiet.'
};

// The phrase accessors live with the phrase data (phrases.js) and are
// re-exported here so a host app can get everything it needs for result
// handling from one import. They take a phrase object, so they work on a
// host's own curriculum, not just the bundled PHRASES.
export { spokenPinyin, isSandhi, acceptedFor, isOptional } from './phrases.js';
import { spokenPinyin, isSandhi, acceptedFor, isOptional } from './phrases.js';

/**
 * Tally an utterance's verdicts, counting only SCORED syllables: neutral
 * positions are excluded from both numerator and denominator, so a phrase
 * ending in a neutral particle can still be "all correct".
 */
export function aggregate (phrase, verdicts) {
  const out = { scored: 0, good: 0, close: 0, bad: 0, uncertain: 0, neutral: 0 };
  phrase.surfaceTones.forEach((tone, i) => {
    if (tone === 0) { out.neutral++; return; }
    const v = verdicts && verdicts[i];
    out.scored++;
    if (v && out[v.verdict] !== undefined) out[v.verdict]++;
  });
  return out;
}

/**
 * One-line summary plus at most ONE actionable tip. Showing every
 * syllable's diagnostic at once buries the thing worth fixing; the first
 * problem in reading order is the one a learner can act on.
 */
export function summaryHtml (agg, phrase, verdicts) {
  if (agg.scored === 0) {
    return '<div class="diagnostic">Nothing to score in this phrase.</div>';
  }
  const head = agg.good === agg.scored
    ? 'All ' + agg.scored + ' tones sounded right.'
    : agg.good + ' of ' + agg.scored + ' tones sounded right.';

  let firstTip = '';
  for (let i = 0; i < phrase.surfaceTones.length; i++) {
    if (phrase.surfaceTones[i] === 0) continue;
    const v = verdicts && verdicts[i];
    if (!v) continue;
    if (v.verdict === 'uncertain') {
      firstTip = escapeHtml(spokenPinyin(phrase, i)) + ': ' +
        escapeHtml(UNCERTAIN_REASON_TEXT[v.reason] || 'not heard clearly.');
      break;
    }
    if (v.diagnostic) {
      firstTip = escapeHtml(spokenPinyin(phrase, i)) + ': ' + escapeHtml(v.diagnostic);
      break;
    }
  }
  return '<strong>' + head + '</strong>' +
    (firstTip ? '<div class="diagnostic">' + firstTip + '</div>' : '');
}

/**
 * The `attempt` event payload — the component's data contract with a host
 * app. Deliberately flat, JSON-serializable, and free of DOM references so
 * an experiment can log it verbatim. Raw per-syllable feature structs are
 * NOT included (they carry large contour arrays); the classifier's scores
 * are, since those are what an outcome analysis needs. `coefs` is kept
 * because four numbers per syllable is a compact, re-analyzable summary of
 * the actual contour the learner produced.
 */
export function buildAttemptDetail (
  phrase, syllableFeatures, verdicts, res, durationSec, registerTrusted
) {
  const scored = verdicts !== null && verdicts !== undefined;
  return {
    phraseId: phrase.id,
    hanzi: phrase.hanzi,
    citationTones: phrase.syllables.map(s => s.tone),
    surfaceTones: phrase.surfaceTones.slice(),
    voiced: !!(res && res.voiced),
    reason: res && res.reason ? res.reason : null,
    segmentationMethod: res && res.segmentation ? res.segmentation.method : null,
    registerTrusted: !!registerTrusted,
    durationSec: durationSec ?? null,
    syllables: phrase.syllables.map((syl, i) => {
      const f = syllableFeatures ? syllableFeatures[i] : null;
      const v = scored ? verdicts[i] : null;
      return {
        index: i,
        pinyin: spokenPinyin(phrase, i),
        citationPinyin: syl.pinyin,
        base: syl.base,
        citationTone: syl.tone,
        surfaceTone: phrase.surfaceTones[i],
        // Every realization that would have been accepted, and the one the
        // learner actually produced. For an optional position (a 3-long T3
        // run's first syllable) these differ, and an outcome analysis needs
        // to know WHICH form was produced, not just that it passed.
        acceptedTones: acceptedFor(phrase, i),
        optional: isOptional(phrase, i),
        matchedTone: v && v.matchedTone !== undefined ? v.matchedTone : null,
        sandhi: isSandhi(phrase, i),
        neutral: phrase.surfaceTones[i] === 0,
        voiced: f ? !!f.voiced : false,
        reason: f && !f.voiced ? f.reason : null,
        verdict: v ? v.verdict : null,
        targetScore: v ? v.targetScore : null,
        bestTone: v ? v.bestTone : null,
        scores: v ? v.scores : null,
        diagnostic: v ? v.diagnostic : null,
        coefs: f && f.voiced ? f.coefs : null
      };
    }),
    aggregate: scored ? aggregate(phrase, verdicts) : null
  };
}

export function escapeHtml (s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}
