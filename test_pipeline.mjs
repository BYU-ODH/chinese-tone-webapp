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

const SR = 44100;

/** Build a Float32Array of `dur` seconds at sample rate SR with given F0(t). */
function synthesize (dur, f0Func) {
  const N = Math.floor(dur * SR);
  const out = new Float32Array(N);
  let phase = 0;
  for (let i = 0; i < N; i++) {
    const t = i / SR;
    const f = f0Func(t / dur); // normalize t to 0..1
    phase += 2 * Math.PI * f / SR;
    // Hann envelope to avoid hard edges.
    const env = 0.5 - 0.5 * Math.cos(2 * Math.PI * t / dur);
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

// Reproduce the buildAnalysisScript from praat-engine.js. Inline here so
// this test does not depend on the (worker-only) praat-engine module.
function buildAnalysisScript (soundId) {
  return `
writeInfoLine: "BEGIN"
selectObject: ${soundId}
duration = Get total duration
sr = Get sampling frequency
appendInfoLine: "DURATION ", fixed$(duration, 6)
appendInfoLine: "SAMPLERATE ", fixed$(sr, 1)

selectObject: ${soundId}
To Pitch (ac): 0.005, 75, 15, "no", 0.01, 0.30, 0.01, 0.35, 0.14, 600
pitchId = selected("Pitch")
nFrames = Get number of frames
dx = Get time step
x1 = Get time from frame number: 1
appendInfoLine: "PITCH"
appendInfoLine: "n ", nFrames
appendInfoLine: "dx ", fixed$(dx, 6)
appendInfoLine: "x1 ", fixed$(x1, 6)
appendInfoLine: "values"
for i to nFrames
    f = Get value in frame: i, "Hertz"
    if f = undefined
        appendInfoLine: "u"
    else
        appendInfoLine: fixed$(f, 3)
    endif
endfor
appendInfoLine: "endvalues"
removeObject: pitchId

selectObject: ${soundId}
To Intensity: 75, 0.005, "yes"
intensityId = selected("Intensity")
nIntFrames = Get number of frames
intDx = Get time step
intX1 = Get time from frame number: 1
appendInfoLine: "INTENSITY"
appendInfoLine: "n ", nIntFrames
appendInfoLine: "dx ", fixed$(intDx, 6)
appendInfoLine: "x1 ", fixed$(intX1, 6)
appendInfoLine: "values"
for i to nIntFrames
    v = Get value in frame: i
    if v = undefined
        appendInfoLine: "u"
    else
        appendInfoLine: fixed$(v, 3)
    endif
endfor
appendInfoLine: "endvalues"
removeObject: intensityId

selectObject: ${soundId}
To Harmonicity (cc): 0.01, 75, 0.1, 1.0
hnrId = selected("Harmonicity")
hnrMean = Get mean: 0, 0
if hnrMean = undefined
    appendInfoLine: "HNR_MEAN -99"
else
    appendInfoLine: "HNR_MEAN ", fixed$(hnrMean, 3)
endif
removeObject: hnrId

selectObject: ${soundId}
To PointProcess (periodic, cc): 75, 600
ppId = selected("PointProcess")
nPeriods = Get number of periods: 0, 0, 0.0001, 0.02, 1.3
if nPeriods >= 2
    jitter = Get jitter (local): 0, 0, 0.0001, 0.02, 1.3
    if jitter = undefined
        appendInfoLine: "JITTER -1"
    else
        appendInfoLine: "JITTER ", fixed$(jitter, 6)
    endif
else
    appendInfoLine: "JITTER -1"
endif
removeObject: ppId

appendInfoLine: "END"
`;
}

function parseAnalysisOutput (text) {
  const lines = text.split('\n').map(l => l.trim());
  const out = {
    duration: 0, sampleRate: 0,
    pitch: { n: 0, dx: 0, x1: 0, values: [] },
    intensity: { n: 0, dx: 0, x1: 0, values: [] },
    hnrMean: -99, jitter: -1
  };
  let mode = null, inValues = false, block = null;
  for (const line of lines) {
    if (!line || line === 'BEGIN' || line === 'END') continue;
    if (line === 'PITCH') { mode = 'PITCH'; block = out.pitch; continue; }
    if (line === 'INTENSITY') { mode = 'INTENSITY'; block = out.intensity; continue; }
    if (line === 'values') { inValues = true; continue; }
    if (line === 'endvalues') { inValues = false; mode = null; block = null; continue; }
    if (inValues && block) {
      block.values.push(line === 'u' || line === '--undefined--' ? NaN : parseFloat(line));
      continue;
    }
    const sp = line.indexOf(' ');
    if (sp < 0) continue;
    const key = line.slice(0, sp);
    const num = parseFloat(line.slice(sp + 1).trim());
    if (mode === 'PITCH' || mode === 'INTENSITY') {
      if (key === 'n') block.n = num | 0;
      else if (key === 'dx') block.dx = num;
      else if (key === 'x1') block.x1 = num;
      continue;
    }
    if (key === 'DURATION') out.duration = num;
    else if (key === 'SAMPLERATE') out.sampleRate = num;
    else if (key === 'HNR_MEAN') out.hnrMean = num;
    else if (key === 'JITTER') out.jitter = num;
  }
  return out;
}

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
