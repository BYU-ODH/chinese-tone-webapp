/*
 * Regression test for utterance.js's extractUtteranceFeatures/
 * classifyUtterance/commitUtteranceToNormalizer.
 *
 * No Praat/WASM needed: these consume plain {n,dx,x1,values} blocks, so we
 * synthesize a two-syllable analysis struct directly, the same way
 * test_normalizer.mjs and test_segmentation.mjs synthesize their inputs.
 *
 * Run from the project root:
 *   node test_utterance.mjs
 */

import { extractUtteranceFeatures, classifyUtterance, commitUtteranceToNormalizer } from './docs/single-word/utterance.js';
import { SpeakerNormalizer } from './docs/single-word/features.js';

const DX = 0.005; // matches the Praat script's 5ms time step
const M = 210;
const st = (s) => M * Math.pow(2, s / 12);

function block (values, dx = DX, x1 = dx / 2) {
  return { n: values.length, dx, x1, values };
}

/** Flat at peakVal across [loEdge,hiEdge], tapering to baseVal over `taper` frames beyond each edge. */
function plateau (n, loEdge, hiEdge, taper, peakVal, baseVal) {
  const out = new Array(n).fill(baseVal);
  for (let i = 0; i < n; i++) {
    if (i >= loEdge && i <= hiEdge) { out[i] = peakVal; continue; }
    const d = i < loEdge ? loEdge - i : i - hiEdge;
    if (d <= taper) out[i] = baseVal + (peakVal - baseVal) * (1 - d / taper);
  }
  return out;
}

function combine (n, baseVal, ...humps) {
  const out = new Array(n).fill(baseVal);
  for (const h of humps) for (let i = 0; i < n; i++) out[i] = Math.max(out[i], h[i]);
  return out;
}

/** Two syllables: a flat T1 (frames 20-70) then a falling T4 (frames 120-170), silence between. */
function twoSyllableAnalysis () {
  const n = 240;
  const pitch = new Array(n).fill(NaN);
  for (let i = 20; i <= 70; i++) pitch[i] = st(5);
  for (let i = 120; i <= 170; i++) pitch[i] = st(5 - 10 * ((i - 120) / 50));

  const intensity = combine(n, 40, plateau(n, 20, 70, 15, 75, 40), plateau(n, 120, 170, 15, 75, 40));
  const harmonicity = new Array(n).fill(15);

  return {
    duration: n * DX,
    hnrMean: 15,
    pitch: block(pitch),
    intensity: block(intensity),
    harmonicity: block(harmonicity)
  };
}

function silentAnalysis () {
  const n = 100;
  return {
    duration: n * DX,
    hnrMean: -99,
    pitch: block(new Array(n).fill(NaN)),
    intensity: block(new Array(n).fill(40)),
    harmonicity: block(new Array(n).fill(NaN))
  };
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

console.log('--- 1. Two-syllable utterance: segments, extracts, and classifies both ---');
{
  const normalizer = new SpeakerNormalizer();
  const targetTones = [1, 4];
  const { voiced, syllables, segmentation } = extractUtteranceFeatures(twoSyllableAnalysis(), normalizer, targetTones);

  check(voiced, 'utterance is voiced');
  check(segmentation.method === 'guided', `segmentation used 'guided' (got '${segmentation?.method}')`);
  check(syllables.length === 2, `2 syllables returned (got ${syllables?.length})`);
  check(syllables.every(f => f.voiced), 'both syllables independently voiced');

  const verdicts = classifyUtterance(syllables, targetTones);
  check(verdicts.length === 2, '2 verdicts returned');
  check(verdicts[0].bestTone === 1 && verdicts[0].verdict !== 'uncertain',
    `syllable 0 (flat T1) classifies as T1 (got T${verdicts[0].bestTone}, ${verdicts[0].verdict})`);
  check(verdicts[1].bestTone === 4 && verdicts[1].verdict !== 'uncertain',
    `syllable 1 (falling T4) classifies as T4 (got T${verdicts[1].bestTone}, ${verdicts[1].verdict})`);

  check(normalizer.utteranceCount === 0, 'normalizer untouched before commit');
  commitUtteranceToNormalizer(normalizer, syllables, targetTones);
  check(normalizer.utteranceCount === 2, `normalizer sees 2 utterances after commit (got ${normalizer.utteranceCount})`);
  check(normalizer.tonesSeen.has(1) && normalizer.tonesSeen.has(4),
    `normalizer's tonesSeen includes both target tones (got ${[...normalizer.tonesSeen]})`);
}

console.log('\n--- 2. Silent clip: no-voice, no crash ---');
{
  const normalizer = new SpeakerNormalizer();
  const result = extractUtteranceFeatures(silentAnalysis(), normalizer, [1, 4]);
  check(result.voiced === false && result.reason === 'no-voice',
    `silent clip returns voiced:false, reason:'no-voice' (got ${JSON.stringify(result)})`);
}

/* ------------------------------------------------------------------ */

console.log('\n' + '='.repeat(40));
console.log(failures === 0 ? 'All checks passed.' : `${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
