/*
 * Headless pipeline smoke test.
 *
 * Generates a synthetic WAV for each of the four tones and runs the full
 * Praat analysis script + feature extraction + classifier. Verifies that:
 *   1. The Praat script executes without error.
 *   2. parseAnalysisOutput produces well-formed pitch + intensity arrays.
 *   3. extractFeatures returns voiced=true with sensible Legendre coefs.
 *   4. classify identifies the synthesized tone with the highest score.
 *
 * Synthetic signals are simple sinusoids whose instantaneous frequency
 * follows an idealized contour for each tone, in a child-typical range.
 *
 * Run from the project root:
 *   node test_pipeline.mjs
 */

import { createPraatWasm } from '/Users/rob/repos/praat.github.io/wasm/js/praat-wasm.mjs';
import { encodeWav } from './docs/single-word/audio.js';
import { extractFeatures, SpeakerNormalizer } from './docs/single-word/features.js';
import { classify } from './docs/single-word/classifier.js';
import { buildAnalysisScript, parseAnalysisOutput } from './docs/single-word/praat-analysis.js';

const SR = 44100;

/** Build a Float32Array of `dur` seconds at sample rate SR with given F0(t). */
function synthesize (dur, f0Func) {
  const N = Math.floor(dur * SR);
  const out = new Float32Array(N);
  let phase = 0;
  // Tukey (flat-top) envelope: short cosine tapers at the edges to avoid hard
  // clicks, but a flat body so intensity is constant across the "vowel" — like
  // a real sustained vowel. A full Hann window would make intensity peak
  // mid-utterance and fall steeply at the edges, which the vowel-core selector
  // would (correctly, for real speech) read as quiet flanks to trim, destroying
  // the F0 shape for tones whose detail lives near the edges (e.g. T3's dip).
  const TAPER = 0.1;
  for (let i = 0; i < N; i++) {
    const t = i / SR;
    const u = t / dur; // normalize to 0..1
    const f = f0Func(u);
    phase += 2 * Math.PI * f / SR;
    let env = 1;
    if (u < TAPER) env = 0.5 - 0.5 * Math.cos(Math.PI * u / TAPER);
    else if (u > 1 - TAPER) env = 0.5 - 0.5 * Math.cos(Math.PI * (1 - u) / TAPER);
    // Slight harmonic for a more voice-like spectrum and HNR > 0.
    out[i] = 0.30 * env * (Math.sin(phase) + 0.4 * Math.sin(2 * phase));
  }
  return out;
}

/* Idealized F0 (Hz) contours for a ~child-voice register, ~280 Hz mean. */
const F0 = {
  1: (u) => 380,                                 // T1: high-flat
  2: (u) => 220 + 180 * u,                       // T2: rising 220 → 400
  3: (u) => 280 - 160 * (1 - (2 * u - 1) ** 2),  // T3: dip to 120 then back
  4: (u) => 420 - 280 * Math.pow(u, 0.6)         // T4: high → low
};

async function main () {
  console.log('Booting praat-wasm…');
  const praat = await createPraatWasm();
  console.log('Ready.\n');

  // Each tone is classified with a FRESH normalizer, simulating "this is
  // the very first utterance of the session." Shape-only classification
  // must succeed before any speaker reference exists.
  let pass = 0, fail = 0;

  for (const tone of [1, 2, 3, 4]) {
    const normalizer = new SpeakerNormalizer();
    console.log(`--- Synthesizing tone ${tone} ---`);
    const samples = synthesize(0.45, F0[tone]);
    const wav = encodeWav(samples, SR);

    const sound = praat.readAudio(wav, `/tmp/t${tone}.wav`);
    if (!sound) { console.log(`  FAIL: readAudio returned null`); fail++; continue; }

    const text = praat.run(buildAnalysisScript(sound.id));
    const analysis = parseAnalysisOutput(text);
    praat.removeAll();

    const voicedCount = analysis.pitch.values.filter(v => Number.isFinite(v) && v > 0).length;
    console.log(`  pitch frames: ${analysis.pitch.n}, voiced: ${voicedCount}, dx=${analysis.pitch.dx.toFixed(4)}`);
    console.log(`  HNR=${analysis.hnrMean.toFixed(2)}, jitter=${analysis.jitter.toFixed(4)}, dur=${analysis.duration.toFixed(3)}s`);

    const features = extractFeatures(analysis, normalizer);
    if (!features.voiced) {
      console.log(`  FAIL: features.voiced=false (reason=${features.reason})`);
      fail++;
      continue;
    }
    console.log(`  coefs: c0=${features.coefs[0].toFixed(2)}  c1=${features.coefs[1].toFixed(2)}  c2=${features.coefs[2].toFixed(2)}  c3=${features.coefs[3].toFixed(2)}`);
    console.log(`  onset=${features.onset.toFixed(2)}  offset=${features.offset.toFixed(2)}`);

    // Add this utterance's voiced F0 to the speaker normalizer for later tones.
    normalizer.add(features.voicedHz);

    const verdict = classify(tone, features);
    const scoresFmt = verdict.scores.map((s, i) => `T${i+1}:${s.toFixed(2)}`).join('  ');
    console.log(`  scores: ${scoresFmt}`);
    console.log(`  verdict: ${verdict.verdict} (target T${tone}, best T${verdict.bestTone})`);
    if (verdict.diagnostic) console.log(`  diagnostic: ${verdict.diagnostic}`);

    if (verdict.bestTone === tone) {
      pass++;
      console.log(`  PASS: classifier picked T${tone}`);
    } else {
      fail++;
      console.log(`  FAIL: classifier picked T${verdict.bestTone}, expected T${tone}`);
    }
    console.log();
  }

  console.log('='.repeat(40));
  console.log(`Result: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(err => { console.error(err); process.exit(2); });
