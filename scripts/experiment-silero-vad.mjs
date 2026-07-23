/*
 * experiment-silero-vad.mjs — Stage 2 Track C: does Silero VAD produce
 * speech/non-speech boundaries that measurably improve downstream tone
 * classification over findSpeechSpan()'s existing intensity+HNR heuristic?
 *
 * CURRENTLY BLOCKED — not runnable to a trustworthy result. The ONNX
 * Runtime + model load and run without error, but silero-vad.mjs's
 * runSileroVad() returns implausible near-zero speech probability for
 * every input tried, including real recorded speech and loud synthetic
 * signals — see that file's header for the full list of ruled-out causes
 * (stale state buffer, input scaling, `sr` tensor rank, missing context
 * window — all checked and fixed/ruled out, none changed the outcome).
 * No Python/torch was available in this environment to cross-check
 * against the official reference implementation directly. Until the
 * underlying probability-output bug is found, any span this script
 * produces (via probsToSpan()) is not meaningful — do not trust an
 * accuracy number from a run of this script without first fixing that.
 *
 * Feasibility trail, still valid regardless of the above: the plan's
 * suggested onnxruntime-node (a native addon) needed a ~270MB unpacked
 * platform binary with no npm available in this environment, so this
 * uses onnxruntime-web's WASM backend instead — fully portable, no native
 * compilation, same underlying goal (runs headlessly in Node). Actual
 * payload: WASM runtime 13.2MB + model 2.3MB ≈ 15.5MB (the plan's prior
 * estimate was ~10MB — a real decision-gate input regardless of whether
 * the accuracy question above gets resolved).
 *
 * Design (ready to produce a real number once unblocked): a HEAD-TO-HEAD
 * SPAN comparison, not a denoising A/B — both paths use the SAME
 * unmodified Praat analysis (pitch/intensity/harmonicity); only the
 * speech span fed into extractSyllableFeatures() differs:
 *   - baseline: prep.speechSpan (findSpeechSpan(), today's production path)
 *   - silero:   Silero VAD's speech-probability-derived span
 * extractSyllableFeatures() itself, and everything downstream of it, is
 * exactly what the shipped app uses — this isolates the SPAN CHOICE as
 * the only variable.
 *
 * Usage (once unblocked):
 *   node scripts/experiment-silero-vad.mjs
 *   TONEAUDIO_STRIDE=4 node scripts/experiment-silero-vad.mjs   # smoke test
 */
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

import { prepUtterance, extractSyllableFeatures, SpeakerNormalizer } from '../docs/single-word/features.js';
import { classify } from '../docs/single-word/classifier.js';
import { buildAnalysisScript, parseAnalysisOutput } from '../docs/single-word/praat-analysis.js';
import { DEFAULT_PRAAT_WASM, quiet } from './lib/corpus-eval.mjs';
import { resolveToneAudioDir, applyStride } from './lib/toneaudio-eval.mjs';
import { buildManifest } from './lib/pinyin-segment.mjs';
import { appendRun, printComparison } from './lib/bench-log.mjs';
import { loadSileroVad, runSileroVad, probsToSpan } from './lib/silero-vad.mjs';

const SCRATCH = process.env.SILERO_SCRATCH_DIR
  || '/private/tmp/claude-503/-Users-rob-repos-BYU-ODH-chinese-tone-webapp/252cb045-9dc6-450e-90de-2763366c5bc3/scratchpad/silero-vad';
const VAD_SAMPLE_RATE = 16000;
const VAD_THRESHOLD = 0.5;

function decodeToPcm (path, rate) {
  const res = spawnSync('ffmpeg', ['-v', 'error', '-i', path, '-f', 'f32le', '-ar', String(rate), '-ac', '1', '-'],
    { maxBuffer: 64 * 1024 * 1024 });
  if (res.status !== 0) throw new Error(`ffmpeg failed on ${path}: ${res.stderr}`);
  const buf = res.stdout;
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength >> 2);
}

/** Convert a Silero {startSec,endSec} span into inclusive pitch-frame indices, clamped to the clip. */
function secondsToFrameSpan (startSec, endSec, t0, dx, maxFrame) {
  const start = Math.max(0, Math.min(maxFrame, Math.round((startSec - t0) / dx)));
  const end = Math.max(start, Math.min(maxFrame, Math.round((endSec - t0) / dx)));
  return { start, end };
}

function scoreSpan (prep, span, target) {
  const f = extractSyllableFeatures(prep, span, new SpeakerNormalizer());
  if (!f.voiced) return { voiced: false, reason: f.reason };
  const v = classify(target, f);
  return { voiced: true, pred: v.bestTone, correct: v.bestTone === target };
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
  console.log('Silero VAD vs findSpeechSpan() — real ToneAudio single-word clips, head-to-head');
  console.log('='.repeat(78));

  const items = applyStride(buildManifest(dir)).filter(m => m.cat === 'single');
  console.log(`${items.length} single-word clips`);

  console.log('loading Praat-WASM + Silero-VAD-WASM...');
  const { createPraatWasm } = await import(DEFAULT_PRAAT_WASM);
  const praat = await createPraatWasm();
  const vad = await loadSileroVad({ ortDir: SCRATCH, modelPath: `${SCRATCH}/silero_vad.onnx` });

  const baseline = [];
  const silero = [];
  let i = 0;
  for (const item of items) {
    i++;
    if (i % 50 === 0) console.log(`  ${i}/${items.length}...`);
    const target = item.tones.length ? item.tones[0] : 1;
    const rec = { token: item.token, speaker: item.speaker, condition: item.condition, tone: target };

    const buf = readFileSync(item.path);
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    const sound = quiet(() => praat.readAudio(ab, '/tmp/clip.mp3'));
    if (!sound) { baseline.push({ ...rec, voiced: false, reason: 'load-failed' }); silero.push({ ...rec, voiced: false, reason: 'load-failed' }); continue; }
    const analysis = parseAnalysisOutput(quiet(() => praat.run(buildAnalysisScript(sound.id))));
    quiet(() => praat.removeAll());

    const prep = prepUtterance(analysis);
    if (!prep.rawSpan) { baseline.push({ ...rec, voiced: false, reason: 'no-voice' }); silero.push({ ...rec, voiced: false, reason: 'no-voice' }); continue; }

    baseline.push({ ...rec, ...scoreSpan(prep, prep.speechSpan, target) });

    try {
      const pcm16k = decodeToPcm(item.path, VAD_SAMPLE_RATE);
      const probs = await runSileroVad(vad, pcm16k);
      const timeSpan = probsToSpan(probs, VAD_THRESHOLD);
      if (!timeSpan) { silero.push({ ...rec, voiced: false, reason: 'vad-no-speech' }); continue; }
      const maxFrame = analysis.pitch.n - 1;
      const frameSpan = secondsToFrameSpan(timeSpan.startSec, timeSpan.endSec, analysis.pitch.x1, analysis.pitch.dx, maxFrame);
      silero.push({ ...rec, ...scoreSpan(prep, frameSpan, target) });
    } catch (e) {
      silero.push({ ...rec, voiced: false, reason: 'error:' + (e.message || '').slice(0, 60) });
    }
  }

  console.log('\nOverall:');
  summarize(baseline, 'baseline (findSpeechSpan)');
  summarize(silero, 'Silero VAD span');

  for (const cond of ['Noisy', 'Quiet']) {
    console.log(`\n${cond}:`);
    summarize(baseline.filter(r => r.condition === cond), 'baseline');
    summarize(silero.filter(r => r.condition === cond), 'Silero VAD span');
  }
  for (const sp of [...new Set(items.map(m => m.speaker))]) {
    for (const cond of ['Noisy', 'Quiet']) {
      const b = baseline.filter(r => r.speaker === sp && r.condition === cond);
      if (!b.length) continue;
      console.log(`\n${sp}/${cond}:`);
      summarize(b, 'baseline');
      summarize(silero.filter(r => r.speaker === sp && r.condition === cond), 'Silero VAD span');
    }
  }

  const logGroup = (records, label) => {
    const voiced = records.filter(r => r.voiced);
    const correct = voiced.filter(r => r.correct);
    appendRun({
      label, corpus: 'toneaudio-single', featureCacheVersion: null,
      sampleSize: { scored: voiced.length, skipped: records.length - voiced.length, total: records.length },
      overall: { correct: correct.length, total: voiced.length, pct: voiced.length ? correct.length / voiced.length : 0 }
    });
  };
  logGroup(baseline, 'silero-vad-experiment: baseline (findSpeechSpan)');
  logGroup(silero, 'silero-vad-experiment: Silero VAD span');
  printComparison('toneaudio-single', 10);
}

main().catch(err => { console.error(err); process.exit(2); });
