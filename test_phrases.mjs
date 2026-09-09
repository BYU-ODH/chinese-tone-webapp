/*
 * Regression test for the multi-syllable phrase trainer's data and scoring
 * logic (docs/multi-syllable/).
 *
 * No browser needed: the component module itself is not imported (it
 * references HTMLElement at class-definition time), which is exactly why
 * the pure logic lives in result.js. Everything below runs on synthesized
 * analysis structs, the same way test_segmentation.mjs and
 * test_utterance.mjs do — no Praat/WASM, no corpus.
 *
 * What this is actually guarding:
 *   1. The curriculum's STORED surfaceTones can't drift from what
 *      resolveSandhi() produces. sandhi.js is an authoring-time tool whose
 *      output is committed by hand; without this check a rule change or a
 *      typo would silently drill learners against the wrong target.
 *   2. No shipped phrase contains an ambiguous 3+ T3 run (an open question
 *      with our Chinese collaborators — see PHRASES' header).
 *   3. Neutral tone doesn't poison the pipeline. This was a real bug: one
 *      tone-0 position made classify() return targetScore undefined, which
 *      turned the guided segmentation DP's path score into NaN and dropped
 *      the WHOLE utterance to the even-split fallback.
 *
 * Run from the project root:
 *   node test_phrases.mjs
 */

import { readFileSync } from 'node:fs';

import { PHRASES, citationTones, spokenPinyin, isSandhi } from './docs/multi-syllable/phrases.js';
import { aggregate, buildAttemptDetail } from './docs/multi-syllable/result.js';
import { resolveSandhi } from './docs/single-word/sandhi.js';
import { classify } from './docs/single-word/classifier.js';
import { bandAcceptedAs } from './docs/single-word/targets.js';
import { SpeakerNormalizer } from './docs/single-word/features.js';
import {
  extractUtteranceFeatures, classifyUtterance, commitUtteranceToNormalizer
} from './docs/single-word/utterance.js';

const DX = 0.01;

let failures = 0;
function check (cond, label) {
  if (cond) {
    console.log(`  PASS: ${label}`);
  } else {
    failures++;
    console.log(`  FAIL: ${label}`);
  }
}

/* --- synthetic multi-syllable audio, matching test_segmentation.mjs --- */

const MID = 210;
const st = (s) => MID * Math.pow(2, s / 12);
const TONE_SHAPES = {
  1: (u) => st(u < 0.15 ? 2.5 + 2.5 * (u / 0.15) : 5),
  2: (u) => st(-1 + 6 * u),
  3: (u) => st(-1 - 6.5 * (1 - Math.pow(2 * u - 1, 2))),
  4: (u) => st(5 - 11 * Math.pow(u, 0.8))
};
const block = (values) => ({ n: values.length, dx: DX, x1: DX / 2, values });

/**
 * Build an analysis struct with one voiced region per entry of `segments`
 * ({lo, hi, tone}), silence in the gaps. A neutral (tone 0) segment is
 * voiced with a flat mid contour — that is what a light syllable actually
 * looks like, and it must survive the pipeline without being scored.
 */
function makeAnalysis (n, segments) {
  const pv = new Array(n).fill(NaN);
  const iv = new Array(n).fill(40);
  const hv = new Array(n).fill(NaN);
  for (const { lo, hi, tone } of segments) {
    const fn = TONE_SHAPES[tone] || (() => st(0));
    for (let i = lo; i <= hi; i++) {
      const u = (i - lo) / Math.max(1, hi - lo);
      pv[i] = fn(u);
      iv[i] = 75;
      hv[i] = 15;
    }
  }
  return {
    duration: n * DX,
    pitch: block(pv), intensity: block(iv), harmonicity: block(hv), hnrMean: 15
  };
}

/* ------------------------------------------------------------------ */

console.log('--- 1. Curriculum: stored surfaceTones match resolveSandhi() ---');
{
  let mismatched = 0;
  let flagged = 0;
  for (const p of PHRASES) {
    const { surfaceTones, flags } = resolveSandhi(p.syllables);
    if (JSON.stringify(surfaceTones) !== JSON.stringify(p.surfaceTones)) {
      mismatched++;
      console.log(`    ${p.id}: stored ${JSON.stringify(p.surfaceTones)} vs computed ${JSON.stringify(surfaceTones)}`);
    }
    if (flags.length) {
      flagged++;
      console.log(`    ${p.id}: resolveSandhi flagged ${JSON.stringify(flags)}`);
    }
  }
  check(PHRASES.length > 0, `${PHRASES.length} phrases in the curriculum`);
  check(mismatched === 0, 'every stored surfaceTones array matches resolveSandhi()');
  check(flagged === 0,
    'no shipped phrase hits an ambiguous 3+ T3 run (those are an open collaborator question)');
}

console.log('\n--- 2. Curriculum: structural integrity ---');
{
  const ids = new Set();
  let dupIds = 0, lengthMismatch = 0, badTone = 0, missingBase = 0, tooShort = 0;
  for (const p of PHRASES) {
    if (ids.has(p.id)) dupIds++;
    ids.add(p.id);
    if (p.surfaceTones.length !== p.syllables.length) lengthMismatch++;
    if (p.syllables.length < 2) tooShort++;
    for (const s of p.syllables) {
      if (![0, 1, 2, 3, 4].includes(s.tone)) badTone++;
      if (!s.base || !s.pinyin) missingBase++;
    }
  }
  check(dupIds === 0, 'phrase ids are unique');
  check(lengthMismatch === 0, 'surfaceTones length matches syllable count for every phrase');
  check(tooShort === 0, 'every phrase has at least 2 syllables (it is the MULTI-syllable app)');
  check(badTone === 0, 'every citation tone is 0-4');
  check(missingBase === 0, 'every syllable has a base and a pinyin form');
}

console.log('\n--- 3. Curriculum: every scored syllable has a real target band ---');
{
  const targets = JSON.parse(readFileSync('./docs/single-word/targets.json', 'utf8'));
  let absent = 0, offModel = 0, scoredCount = 0;
  for (const p of PHRASES) {
    p.syllables.forEach((s, i) => {
      const surfaceTone = p.surfaceTones[i];
      if (surfaceTone === 0) return;            // neutral: no band by design
      scoredCount++;
      const entry = targets.syllables?.[s.base]?.[surfaceTone];
      if (!entry || !Array.isArray(entry.coefs)) {
        absent++;
        console.log(`    ${p.id}: ${s.base} tone ${surfaceTone} absent from targets.json`);
        return;
      }
      // Not a failure — getSyllableTargets() substitutes a canonical shape
      // when the corpus mean wouldn't classify as its own tone. Reported so
      // a curriculum author can see which drills fall back.
      if (!bandAcceptedAs(surfaceTone, entry)) offModel++;
    });
  }
  check(absent === 0,
    `all ${scoredCount} scored (syllable, surface tone) pairs exist in targets.json`);
  console.log(`    note: ${offModel}/${scoredCount} use the canonical fallback band (corpus mean off-model)`);
}

console.log('\n--- 4. Neutral tone is not scored, and does not poison the pipeline ---');
{
  const v = classify(0, {
    voiced: true, coefs: [0, 1, 2, 0], offset: 0,
    voicedFrameCount: 100, registerTrusted: false
  });
  check(v.verdict === 'neutral', `classify(0, ...) verdict is 'neutral' (got '${v.verdict}')`);
  check(v.targetScore === null, `classify(0, ...) targetScore is null (got ${v.targetScore})`);
  check(v.bestTone === null, 'classify(0, ...) reports no bestTone, so no UI can claim it heard one');

  // The actual regression: a neutral position used to NaN out the DP and
  // force the whole utterance onto the even-split fallback.
  const analysis = makeAnalysis(80, [{ lo: 5, hi: 34, tone: 4 }, { lo: 40, hi: 74, tone: 0 }]);
  const res = extractUtteranceFeatures(analysis, new SpeakerNormalizer(), [4, 0]);
  check(res.voiced, 'utterance with a neutral syllable is voiced');
  check(res.segmentation.method === 'guided',
    `segmentation stays 'guided' with a neutral position (got '${res.segmentation.method}')`);
  const verdicts = classifyUtterance(res.syllables, [4, 0]);
  check(verdicts.length === 2, '2 verdicts returned');
  check(verdicts[1].verdict === 'neutral', 'the neutral syllable is reported neutral, not bad');
  check(verdicts.every(x => x.targetScore === null || Number.isFinite(x.targetScore)),
    'no NaN/undefined targetScore anywhere in the utterance');
}

console.log('\n--- 5. aggregate() excludes neutral syllables from the score ---');
{
  const phrase = PHRASES.find(p => p.surfaceTones.includes(0));
  check(!!phrase, `curriculum contains a neutral-tone phrase (${phrase && phrase.id})`);
  const verdicts = phrase.surfaceTones.map(t =>
    t === 0 ? { verdict: 'neutral', targetScore: null } : { verdict: 'good', targetScore: 0.9 });
  const agg = aggregate(phrase, verdicts);
  const expectScored = phrase.surfaceTones.filter(t => t !== 0).length;
  check(agg.scored === expectScored,
    `scored counts only non-neutral syllables (${agg.scored} of ${phrase.surfaceTones.length})`);
  check(agg.neutral === phrase.surfaceTones.filter(t => t === 0).length,
    'neutral syllables are counted separately');
  check(agg.good === expectScored && agg.good === agg.scored,
    'a phrase whose scored syllables are all good reads as fully correct');
}

console.log('\n--- 6. Sandhi surfaces correctly in the display/accessor layer ---');
{
  const nihao = PHRASES.find(p => p.id === 'ni-hao');
  check(citationTones(nihao).join() === '3,3', 'ni-hao citation tones are T3 T3');
  check(nihao.surfaceTones.join() === '2,3', 'ni-hao surface tones are T2 T3');
  check(spokenPinyin(nihao, 0) === 'ní', `first syllable is spoken 'ní' (got '${spokenPinyin(nihao, 0)}')`);
  check(isSandhi(nihao, 0) === true, 'first syllable is flagged as sandhi-changed');
  check(isSandhi(nihao, 1) === false, 'second syllable is not flagged');

  const buhao = PHRASES.find(p => p.id === 'bu-hao');
  check(isSandhi(buhao, 0) === false,
    "不 before a T3 keeps its citation tone, so it is not marked as sandhi");
}

console.log('\n--- 7. attempt payload: shape, completeness, serializability ---');
{
  const phrase = PHRASES.find(p => p.id === 'xie-xie');
  const analysis = makeAnalysis(80, [{ lo: 5, hi: 34, tone: 4 }, { lo: 40, hi: 74, tone: 0 }]);
  const norm = new SpeakerNormalizer();
  const res = extractUtteranceFeatures(analysis, norm, phrase.surfaceTones);
  const verdicts = classifyUtterance(res.syllables, phrase.surfaceTones);
  commitUtteranceToNormalizer(norm, res.syllables, phrase.surfaceTones);

  const detail = buildAttemptDetail(phrase, res.syllables, verdicts, res, 0.8, false);
  check(detail.phraseId === 'xie-xie', 'payload carries the phrase id');
  check(detail.syllables.length === phrase.syllables.length,
    'one payload entry per syllable');
  check(detail.citationTones.join() === '4,0' && detail.surfaceTones.join() === '4,0',
    'payload carries both citation and surface tones');
  check(detail.syllables[1].neutral === true, 'the neutral syllable is marked neutral');
  check(detail.segmentationMethod === 'guided',
    `payload reports the segmentation method ('${detail.segmentationMethod}')`);
  check(detail.aggregate && detail.aggregate.scored === 1,
    'payload aggregate counts exactly the one scored syllable');
  check(Array.isArray(detail.syllables[0].coefs) && detail.syllables[0].coefs.length === 4,
    'payload carries the produced contour as 4 Legendre coefficients');

  // A host app logs this verbatim, so it must survive a JSON round-trip
  // with no DOM references, no NaN, and no undefined.
  const json = JSON.stringify(detail);
  check(typeof json === 'string' && json.length > 0, 'payload is JSON-serializable');
  check(!json.includes('NaN') && !json.includes('undefined'),
    'payload contains no NaN or undefined values');
  check(JSON.stringify(JSON.parse(json)) === json, 'payload survives a JSON round-trip unchanged');
}

console.log('\n--- 8. A no-voice recording reports cleanly instead of throwing ---');
{
  const phrase = PHRASES.find(p => p.id === 'zhong-guo');
  const silent = makeAnalysis(60, []);
  const res = extractUtteranceFeatures(silent, new SpeakerNormalizer(), phrase.surfaceTones);
  check(res.voiced === false, 'silent clip returns voiced:false');
  check(res.reason === 'no-voice', `reason is 'no-voice' (got '${res.reason}')`);
  const detail = buildAttemptDetail(phrase, null, null, res, 0.5, false);
  check(detail.voiced === false && detail.aggregate === null,
    'payload for an unscored attempt has voiced:false and a null aggregate');
  check(detail.syllables.every(s => s.verdict === null),
    'no syllable claims a verdict when nothing was heard');
  check(JSON.stringify(detail).length > 0, 'unscored payload is still serializable');
}

console.log('\n--- 9. A real two-syllable phrase scores end to end ---');
{
  const phrase = PHRASES.find(p => p.id === 'zhong-guo');   // T1 then T2
  const analysis = makeAnalysis(80, [{ lo: 5, hi: 34, tone: 1 }, { lo: 40, hi: 74, tone: 2 }]);
  const norm = new SpeakerNormalizer();
  const res = extractUtteranceFeatures(analysis, norm, phrase.surfaceTones);
  check(res.voiced && res.syllables.length === 2, 'both syllables extracted');
  check(res.segmentation.method === 'guided', 'segmented by guided search, not fallback');
  const verdicts = classifyUtterance(res.syllables, phrase.surfaceTones);
  check(verdicts.every(v => v.verdict !== 'uncertain'), 'both syllables were scoreable');
  check(verdicts.every(v => v.verdict !== 'bad'),
    `clean synthetic T1+T2 is not marked wrong (got ${verdicts.map(v => v.verdict).join(', ')})`);
  const agg = aggregate(phrase, verdicts);
  check(agg.scored === 2 && agg.neutral === 0, 'both syllables count toward the score');
}

/* ------------------------------------------------------------------ */

console.log('\n' + '='.repeat(40));
console.log(failures === 0 ? 'All checks passed.' : `${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
