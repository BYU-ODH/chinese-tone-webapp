/*
 * Multi-syllable utterance orchestration: segment, extract, classify.
 *
 * extractUtteranceFeatures() computes the shared speech span once (see
 * prepUtterance), calls segmentSyllables() to find syllable boundaries,
 * then calls extractSyllableFeatures() once per resulting span — the SAME
 * per-syllable helper the single-word app's extractFeatures() wraps, so
 * behavior never silently diverges between the two apps.
 *
 * classifyUtterance() is the confirmation that sandhi-awareness (see
 * sandhi.js) is a pre-classification "which tone number to pass" decision,
 * never a scoring-math change: classify() itself is unmodified, and
 * already returns a correct 'uncertain' verdict on its own for any
 * unvoiced syllable — no special-casing needed here.
 *
 * Design choice with no single-word precedent: the shared SpeakerNormalizer
 * is updated with every syllable's referenceFrames only AFTER the whole
 * utterance has been classified (commitUtteranceToNormalizer, called once,
 * last), so a multi-syllable utterance is scored self-consistently against
 * the register as it stood BEFORE the utterance started — mirroring the
 * existing utterance-to-utterance (never mid-utterance) normalizer.add()
 * timing in app.js.
 */
import { prepUtterance, extractSyllableFeatures } from './features.js';
import { segmentSyllables } from './segmentation.js';
import { classify } from './classifier.js';

/**
 * @param {object} analysis      Praat analysis struct (see praat-analysis.js)
 * @param {SpeakerNormalizer} normalizer
 * @param {number[]} targetTones expected citation tones, in order — its
 *   length is the expected syllable count segmentSyllables() targets
 * @returns {{voiced:boolean, reason?:string, syllables?:object[], segmentation?:{method:string}}}
 *   syllables[i] is extractSyllableFeatures()'s per-span struct (each
 *   independently .voiced true/false), in time order. segmentation.method
 *   is 'peaks' or 'even-split' (see segmentation.js) so callers/UI can
 *   flag a best-guess split rather than presenting it as confidently exact.
 */
export function extractUtteranceFeatures (analysis, normalizer, targetTones) {
  const prep = prepUtterance(analysis);
  if (!prep.rawSpan) {
    return { voiced: false, reason: 'no-voice' };
  }

  // Segment within rawSpan, NOT prep.speechSpan: speechSpan is trimmed by
  // findSpeechSpan around a single loudness peak, which would incorrectly
  // discard every syllable but the loudest one (see prepUtterance). Noise
  // rejection here is segmentSyllables' own job (prominence + voicing
  // checks), not findSpeechSpan's.
  const { spans, method } = segmentSyllables(
    analysis.intensity, analysis.pitch, targetTones.length, prep.rawSpan);
  const syllables = spans.map(span => extractSyllableFeatures(prep, span, normalizer));

  return { voiced: true, syllables, segmentation: { method } };
}

/**
 * Classify each syllable against its sandhi-resolved surface tone (see
 * sandhi.js's resolveSandhi — surfaceTones is expected to already be
 * resolved by the time this is called; same length/order as syllables).
 */
export function classifyUtterance (syllables, surfaceTones) {
  return syllables.map((f, i) => classify(surfaceTones[i], f));
}

/**
 * Feed every syllable's referenceFrames into the shared normalizer, all at
 * once, AFTER classifyUtterance() has already scored the whole utterance —
 * never before or mid-utterance (see the file-level doc comment for why).
 * Unvoiced syllables have no referenceFrames and are skipped.
 */
export function commitUtteranceToNormalizer (normalizer, syllables, surfaceTones) {
  syllables.forEach((f, i) => {
    if (f.voiced) normalizer.add(f.referenceFrames, surfaceTones[i]);
  });
}
