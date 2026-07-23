/*
 * experiment-rnnoise.mjs — Stage 2 Track B: does RNNoise denoising, fed
 * through the UNMODIFIED existing pipeline, measurably improve tone
 * classification on real ToneAudio single-word clips?
 *
 * Feasibility spike (see chat record for the full trail): the first two
 * readily-available prebuilt packages were both broken in Node —
 * @timephy/rnnoise-wasm's "sync" build corrupts its own WASM heap and
 * crashes in destroy() as soon as it's fed real (non-all-zero) audio;
 * @jitsi/rnnoise-wasm's async loader unconditionally prefers fetch() for
 * the wasm binary, which fails in Node regardless of environment
 * detection. @shiguredo/rnnoise-wasm (2025.1.5) DOES work: it's built with
 * ENVIRONMENT=web,worker and throws on load unless `window` exists, but a
 * one-line polyfill (`globalThis.window = globalThis`) is enough — no
 * other browser API is touched. 300 frames of real (sine + noise) signal
 * processed and destroyed cleanly with this build; that's what's wired in
 * below. Native RNNoise sample rate is 48kHz (no resampling-rate constant
 * is exposed by this build, unlike @timephy's hardcoded 44100).
 *
 * The RNNoise WASM module is NOT vendored into the repo — this is a
 * feasibility/accuracy spike, not yet a committed dependency (per the
 * plan's "don't pre-decide" on adoption before the accuracy delta is
 * known). Its file lives in the session scratchpad; point
 * RNNOISE_WASM_DIR at wherever you downloaded @shiguredo/rnnoise-wasm's
 * dist/rnnoise.js to if it's not there.
 *
 * Usage:
 *   node scripts/experiment-rnnoise.mjs
 *   TONEAUDIO_STRIDE=4 node scripts/experiment-rnnoise.mjs   # smoke test
 */
import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

import { extractFeatures, SpeakerNormalizer } from '../docs/single-word/features.js';
import { classify } from '../docs/single-word/classifier.js';
import { buildAnalysisScript, parseAnalysisOutput } from '../docs/single-word/praat-analysis.js';
import { encodeWav } from '../docs/single-word/audio.js';
import { DEFAULT_PRAAT_WASM, quiet } from './lib/corpus-eval.mjs';
import { resolveToneAudioDir, applyStride } from './lib/toneaudio-eval.mjs';
import { buildManifest } from './lib/pinyin-segment.mjs';
import { appendRun, printComparison } from './lib/bench-log.mjs';

const RNNOISE_DIR = process.env.RNNOISE_WASM_DIR
  || '/private/tmp/claude-503/-Users-rob-repos-BYU-ODH-chinese-tone-webapp/252cb045-9dc6-450e-90de-2763366c5bc3/scratchpad/rnnoise-shiguredo';
const RNNOISE_FREQ = 48000; // RNNoise's native rate; this build exposes no rate constant of its own
const PCM16_SCALE = 32768; // this build expects/returns samples pre-scaled to 16-bit-PCM range, unlike @timephy's package which scaled internally

/** Decode any audio file to Float32 mono PCM at `rate` Hz via ffmpeg (already confirmed present). */
function decodeToPcm (path, rate) {
  const res = spawnSync('ffmpeg', ['-v', 'error', '-i', path, '-f', 'f32le', '-ar', String(rate), '-ac', '1', '-'],
    { maxBuffer: 64 * 1024 * 1024 });
  if (res.status !== 0) throw new Error(`ffmpeg failed on ${path}: ${res.stderr}`);
  const buf = res.stdout;
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength >> 2);
}

/** Denoise Float32 PCM ([-1,1] range) frame by frame, with a fresh DenoiseState (no cross-clip RNN-state leakage). */
function denoise (pcm, rnnoise) {
  const frameSize = rnnoise.frameSize;
  const state = rnnoise.createDenoiseState();
  const out = new Float32Array(pcm.length);
  const frame = new Float32Array(frameSize);
  for (let i = 0; i < pcm.length; i += frameSize) {
    const n = Math.min(frameSize, pcm.length - i);
    frame.fill(0);
    for (let j = 0; j < n; j++) frame[j] = pcm[i + j] * PCM16_SCALE;
    state.processFrame(frame);
    for (let j = 0; j < n; j++) out[i + j] = frame[j] / PCM16_SCALE;
  }
  state.destroy();
  return out;
}

async function loadRnnoise () {
  const file = join(RNNOISE_DIR, 'dist', 'rnnoise.js');
  if (!existsSync(file)) {
    throw new Error(`RNNoise WASM file not found at ${file} — set RNNOISE_WASM_DIR.`);
  }
  globalThis.window = globalThis; // this build is compiled ENVIRONMENT=web,worker and refuses to load without `window`
  const { Rnnoise } = await import(file);
  return Rnnoise.load();
}

/** Run one clip through readAudio -> extractFeatures -> classify given raw file bytes (mp3 or wav) + a tag for readAudio's filename hint. */
function analyzeBytes (praat, ab, tag, target) {
  const sound = quiet(() => praat.readAudio(ab, tag));
  if (!sound) return { voiced: false, reason: 'load-failed' };
  const analysis = parseAnalysisOutput(quiet(() => praat.run(buildAnalysisScript(sound.id))));
  quiet(() => praat.removeAll());
  const f = extractFeatures(analysis, new SpeakerNormalizer());
  if (!f.voiced) return { voiced: false, reason: f.reason };
  const v = classify(target, f);
  return { voiced: true, pred: v.bestTone, correct: v.bestTone === target, hnrMean: f.hnrMean };
}

function summarize (records, label) {
  const voiced = records.filter(r => r.voiced);
  const correct = voiced.filter(r => r.correct);
  console.log(`  ${label}: voiced ${voiced.length}/${records.length} (${(100 * voiced.length / records.length).toFixed(1)}%)  ` +
    `accuracy ${correct.length}/${voiced.length} = ${(100 * correct.length / Math.max(1, voiced.length)).toFixed(1)}%`);
}

async function main () {
  const dir = resolveToneAudioDir(process.env.TONEAUDIO_DIR);
  if (!dir) { console.error('No ToneAudio_* corpus directory found.'); process.exit(1); }

  console.log('='.repeat(78));
  console.log('RNNoise A/B — real ToneAudio single-word clips, paired comparison');
  console.log('='.repeat(78));

  const items = applyStride(buildManifest(dir)).filter(m => m.cat === 'single');
  console.log(`${items.length} single-word clips`);

  console.log('loading Praat-WASM + RNNoise-WASM...');
  const { createPraatWasm } = await import(DEFAULT_PRAAT_WASM);
  const praat = await createPraatWasm();
  const rnnoise = await loadRnnoise();

  const baseline = [];
  const denoised = [];
  let i = 0;
  for (const item of items) {
    i++;
    if (i % 50 === 0) console.log(`  ${i}/${items.length}...`);
    const target = item.tones.length ? item.tones[0] : 1;
    const rec = { token: item.token, speaker: item.speaker, condition: item.condition, tone: target };

    const rawBuf = readFileSync(item.path);
    const rawAb = rawBuf.buffer.slice(rawBuf.byteOffset, rawBuf.byteOffset + rawBuf.byteLength);
    baseline.push({ ...rec, ...analyzeBytes(praat, rawAb, '/tmp/clip.mp3', target) });

    try {
      const pcm = decodeToPcm(item.path, RNNOISE_FREQ);
      const den = denoise(pcm, rnnoise);
      const wav = encodeWav(den, RNNOISE_FREQ);
      denoised.push({ ...rec, ...analyzeBytes(praat, wav, '/tmp/clip.wav', target) });
    } catch (e) {
      denoised.push({ ...rec, voiced: false, reason: 'error:' + (e.message || '').slice(0, 60) });
    }
  }

  console.log('\nOverall:');
  summarize(baseline, 'baseline (untouched mp3)');
  summarize(denoised, 'RNNoise-denoised');

  for (const cond of ['Noisy', 'Quiet']) {
    console.log(`\n${cond}:`);
    summarize(baseline.filter(r => r.condition === cond), 'baseline');
    summarize(denoised.filter(r => r.condition === cond), 'RNNoise-denoised');
  }
  for (const sp of [...new Set(items.map(m => m.speaker))]) {
    for (const cond of ['Noisy', 'Quiet']) {
      const key = `${sp}/${cond}`;
      const b = baseline.filter(r => r.speaker === sp && r.condition === cond);
      if (!b.length) continue;
      console.log(`\n${key}:`);
      summarize(b, 'baseline');
      summarize(denoised.filter(r => r.speaker === sp && r.condition === cond), 'RNNoise-denoised');
    }
  }

  const logGroup = (records, label, extra = {}) => {
    const voiced = records.filter(r => r.voiced);
    const correct = voiced.filter(r => r.correct);
    appendRun({
      label, corpus: 'toneaudio-single', featureCacheVersion: null,
      sampleSize: { scored: voiced.length, skipped: records.length - voiced.length, total: records.length },
      overall: { correct: correct.length, total: voiced.length, pct: voiced.length ? correct.length / voiced.length : 0 },
      ...extra
    });
  };
  logGroup(baseline, 'rnnoise-experiment: baseline (untouched mp3)');
  logGroup(denoised, 'rnnoise-experiment: RNNoise-denoised');
  printComparison('toneaudio-single', 10);
}

main().catch(err => { console.error(err); process.exit(2); });
