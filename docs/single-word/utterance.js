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
import { segmentSyllablesGuided } from './segmentation.js';
import { classify } from './classifier.js';
import { buildReferences, matchUtterance } from './tone-match.js';

/**
 * @param {object} analysis      Praat analysis struct (see praat-analysis.js)
 * @param {SpeakerNormalizer} normalizer
 * @param {number[]} targetTones expected surface tones, in order — its
 *   length is the expected syllable count segmentSyllablesGuided() targets
 * @param {number[][]} [acceptedTones] sandhi.js's acceptedTones: every
 *   acceptable realization per position. Passed through to the boundary
 *   search so a genuinely optional position (a 3-long T3 run's first
 *   syllable) isn't scored against one arbitrary choice.
 * @returns {{voiced:boolean, reason?:string, syllables?:object[],
 *   spans?:{start:number,end:number}[], segmentation?:{method:string}}}
 *   syllables[i] is extractSyllableFeatures()'s per-span struct (each
 *   independently .voiced true/false), in time order. segmentation.method
 *   is 'guided' or 'even-split' (see segmentation.js) so callers/UI can
 *   flag a best-guess split rather than presenting it as confidently exact.
 *   spans[i] is the inclusive pitch-frame range syllables[i] was extracted
 *   from — returned because a caller that wants to act on a syllable's
 *   TIME EXTENT (pitch-correct.js, which rewrites F0 over exactly the span
 *   the target band was drawn across) cannot recover it from the feature
 *   struct: an unvoiced syllable carries no contour at all, and a voiced
 *   one only carries frames, not the boundaries they were chosen from.
 */
export function extractUtteranceFeatures (analysis, normalizer, targetTones, acceptedTones = null) {
  const prep = prepUtterance(analysis);
  if (!prep.rawSpan) {
    return { voiced: false, reason: 'no-voice' };
  }

  // Segment within rawSpan, NOT prep.speechSpan: speechSpan is trimmed by
  // findSpeechSpan around a single loudness peak, which would incorrectly
  // discard every syllable but the loudest one (see prepUtterance). Noise
  // rejection here is segmentation's own job, not findSpeechSpan's.
  //
  // segmentSyllablesGuided(), not the blind intensity-peak segmentSyllables():
  // measured on 1,027 real double-syllable ToneAudio clips at +13.2pp over
  // even-split (67.3% vs 54.1%), vs. blind peak-picking's +0.6pp at its own
  // best tuning (segmentation.js's file header has the full history — peak-
  // picking was measured and found wanting; this wasn't). normalizer is
  // passed through read-only here — segmentation never calls .add(), so
  // this doesn't affect the register reference, only which candidate spans
  // get scored against which target tone during the boundary search.
  const { spans, method } = segmentSyllablesGuided(prep, targetTones, normalizer, { acceptedTones });
  const syllables = spans.map(span => extractSyllableFeatures(prep, span, normalizer));

  return { voiced: true, syllables, spans, segmentation: { method } };
}

/**
 * Classify each syllable against its sandhi-resolved surface tone (see
 * sandhi.js's resolveSandhi — the tones are expected to already be resolved
 * by the time this is called; same length/order as syllables).
 *
 * `acceptedTones` (optional) carries every acceptable realization per
 * position. Where a position lists more than one — a 3-long T3 run's first
 * syllable can be produced as either T3 or T2, per our collaborators — the
 * learner is correct if ANY of them matches, so each is scored and the best
 * result is kept. Scoring such a position against a single arbitrary choice
 * would mark a correct production wrong, which is the specific failure this
 * whole pipeline is built to avoid.
 *
 * Every returned verdict carries `matchedTone`: the realization it was
 * actually scored against. For single-option positions that is just the
 * surface tone; for optional ones it tells a caller (and an experiment log)
 * which form the learner produced.
 */
export function classifyUtterance (syllables, surfaceTones, acceptedTones = null) {
  return syllables.map((f, i) => {
    const options = (acceptedTones && acceptedTones[i]) || [surfaceTones[i]];
    let best = null;
    for (const tone of options) {
      const v = classify(tone, f);
      // Rank by targetScore. A neutral position's score is null (not
      // scored) and such positions are never optional, so the first and
      // only option is always taken there.
      if (best === null || (v.targetScore ?? -1) > (best.targetScore ?? -1)) {
        best = { ...v, matchedTone: tone };
      }
    }
    return best;
  });
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

/**
 * Score an utterance the way the learner is shown it: good/close/bad from
 * tone-match.js's geometry, coaching sentence from classifier.js.
 *
 * WHY THE VERDICT MOVED. The verdict now comes from the same object viz.js
 * draws, so "my line is inside the band" and "I was marked right" cannot
 * disagree — the failure this whole effort started from. classify() keeps two
 * jobs it is still better at: writing the diagnostic sentence, and reporting
 * which tone it thought it heard, which is carried through to the attempt
 * payload so a disagreement between the two models stays visible in the data
 * rather than being silently resolved here.
 *
 * The diagnostic is borrowed across models, which is a real seam: classify()
 * writes its hint from its own rules, so it can explain a syllable that geometry
 * marked down for a slightly different reason. It is the only source of coaching
 * text in the project, and a wrong-but-relevant hint beats none; worth
 * revisiting if the two are seen to disagree in practice.
 *
 * SANDHI-OPTIONAL POSITIONS fall out for free. Where a position accepts more
 * than one realization, every accepted tone's references are offered to the
 * matcher together and the nearest wins, so `matchedTone` is decided by the same
 * geometry as everything else rather than by a separate rule.
 *
 * @param {object[]} syllables   extractSyllableFeatures() structs, in order
 * @param {number[]} surfaceTones  sandhi-resolved surface tones
 * @param {number[][]} [acceptedTones]  every acceptable realization per position
 * @returns {{shift:number, shiftClamped:boolean, verdicts:object[],
 *   matches:object[], references:Array[]}}
 */
export function scoreUtterance (syllables, surfaceTones, acceptedTones = null, opts = {}) {
  const references = syllables.map((_f, i) => {
    const options = (acceptedTones && acceptedTones[i]) || [surfaceTones[i]];
    return options
      .filter(t => t >= 1 && t <= 4)
      .flatMap(t => buildReferences(t));
  });

  const { shift, shiftClamped, matches } = matchUtterance(syllables, references, opts);

  const verdicts = syllables.map((f, i) => {
    // Neutral tone is shown but never scored — there is no validated T0
    // acoustic model, and marking a learner right or wrong against an invented
    // one is the confidently-wrong feedback this pipeline exists to avoid.
    if (surfaceTones[i] === 0) {
      return { verdict: 'neutral', matchedTone: 0, diagnostic: null, targetScore: null,
        bestTone: null, scores: [0, 0, 0, 0] };
    }
    if (!f || !f.voiced) {
      return { verdict: 'uncertain', reason: f && f.reason, matchedTone: null,
        diagnostic: null, targetScore: 0, bestTone: null, scores: [0, 0, 0, 0] };
    }

    const m = matches[i];
    const matchedTone = m ? m.ref.tone : surfaceTones[i];
    const cls = classify(matchedTone, f);
    return {
      verdict: m ? m.verdict : 'uncertain',
      matchedTone,
      diagnostic: (m && m.verdict === 'good') ? null : cls.diagnostic,
      // Geometry's own numbers, for the display and for analysis.
      rms: m ? m.rms : null,
      shift: m ? m.shift : null,
      durationRatio: m ? m.durationRatio : null,
      durationOk: m ? m.durationOk : null,
      // classify()'s opinion, kept so model disagreement is visible downstream.
      targetScore: cls.targetScore,
      bestTone: cls.bestTone,
      scores: cls.scores
    };
  });

  return { shift, shiftClamped, verdicts, matches, references };
}
