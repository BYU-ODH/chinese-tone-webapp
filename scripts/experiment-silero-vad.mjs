/*
 * experiment-silero-vad.mjs — Stage 2 Track C: does Silero VAD produce
 * speech/non-speech boundaries that measurably improve downstream tone
 * classification over findSpeechSpan()'s existing intensity+HNR heuristic?
 *
 * CONCLUSION: YES, with the right span-extraction tuning — this is the
 * first Stage 2 track measured to clear the plan's own decision gate
 * ("improves Noisy without regressing Quiet"). Full-corpus (248 ToneAudio
 * single-word clips) result for silero-vad.mjs's
 * MONOSYLLABLE_HYSTERESIS_OPTIONS: 55.2% overall accuracy at 96.4%
 * coverage, vs. baseline's 53.7% at 98.4% — Noisy 31.6%→36.8%, Quiet
 * 63.7%→63.8%, with no real regression in any of the four speaker×
 * condition slices. See scripts/results/history.json for every run logged
 * along the way (thresholds, ricky0123's real defaults, and the retuned
 * candidates below).
 *
 * Getting here took three fixes, each found by comparing against
 * ricky0123/vad (github.com/ricky0123/vad) — the actively-maintained JS
 * wrapper the Silero ecosystem points to:
 *   1. Wrong windowing protocol. silero-vad.mjs was feeding v5's model a
 *      legacy/v4-style sliding window (64-sample context carried over a
 *      448-sample hop). v5's own reference wrapper feeds disjoint,
 *      non-overlapping 512-sample frames with no context concatenation —
 *      that's a legacy/v4-only concept.
 *   2. Wrong model weights. The downloaded silero_vad.onnx was a
 *      structurally valid v5-shaped graph (same tensor names, same
 *      STFT-based architecture) matching ricky0123/vad's silero_vad_v5.onnx
 *      byte-for-byte in size (2,327,524 bytes) but not content: SHA256
 *      mismatch, ~1.77M of 2.3M bytes differing. Wrong/untrained-for-this-
 *      export weights, not a WASM-runtime bug. Fixing #1 alone did not
 *      resolve the near-zero-probability symptom this caused; swapping in
 *      ricky0123/vad's actual model file (cached at
 *      .tone-cache/silero-vad/silero_vad.onnx, git-ignored) did.
 *   3. Wrong span-extraction tuning. Once probabilities were sane, a naive
 *      single-threshold first/last cut and even ricky0123's real
 *      FrameProcessor hysteresis defaults both underperformed baseline —
 *      the latter badly (46.3%/59.3% coverage), because minSpeechMs:400/
 *      redemptionMs:1400 are tuned for continuous multi-second
 *      conversational speech, not ~1-2s isolated monosyllables, and
 *      rejected ~40% of clips outright as misfires. Rescaling those
 *      durations to this corpus's actual speech-span lengths (commonly
 *      300-700ms) while keeping the hysteresis mechanism intact is what
 *      finally cleared the decision gate.
 *
 * Feasibility trail, still valid regardless of the above: the plan's
 * suggested onnxruntime-node (a native addon) needed a ~270MB unpacked
 * platform binary with no npm available in this environment, so this
 * uses onnxruntime-web's WASM backend instead — fully portable, no native
 * compilation, same underlying goal (runs headlessly in Node). Actual
 * payload: WASM runtime 13.2MB + model 2.3MB ≈ 15.5MB (the plan's prior
 * estimate was ~10MB — a real decision-gate input regardless of the
 * accuracy question above; this is the cost to weigh against the
 * accuracy win once Tracks A/B/D also have numbers, per Stage 2's overall
 * decision gate — not pre-empted here).
 *
 * Design: a HEAD-TO-HEAD SPAN comparison, not a denoising A/B — every arm
 * uses the SAME unmodified Praat analysis (pitch/intensity/harmonicity);
 * only the speech span fed into extractSyllableFeatures() differs:
 *   - baseline:   prep.speechSpan (findSpeechSpan(), today's production path)
 *   - silero:     probsToSpan() — naive single-threshold first/last cut
 *   - hysteresis candidates: probsToSpanHysteresis() — a port of
 *     ricky0123/vad's FrameProcessor state machine (separate rise/fall
 *     thresholds, redemption grace, pre-speech padding, minimum-duration
 *     misfire rejection), swept from their real defaults down to this
 *     corpus's actual clip length. All arms derive from the SAME probs
 *     array per clip (one Silero inference pass), so sweeping span-
 *     extraction tunings costs no extra inference.
 * extractSyllableFeatures() itself, and everything downstream of it, is
 * exactly what the shipped app uses — this isolates the SPAN CHOICE as
 * the only variable.
 *
 * Usage:
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
import { loadSileroVad, runSileroVad, probsToSpan, probsToSpanHysteresis, MONOSYLLABLE_HYSTERESIS_OPTIONS } from './lib/silero-vad.mjs';

const SCRATCH = process.env.SILERO_SCRATCH_DIR
  || new URL('../.tone-cache/silero-vad', import.meta.url).pathname;
const VAD_SAMPLE_RATE = 16000;
// ricky0123/vad's own production default is 0.3 (with a separate, lower
// 0.25 negative/release threshold for hysteresis) — 0.5 is this script's
// original single-flat-threshold guess, not a tuned value. Override to sweep.
const VAD_THRESHOLD = process.env.VAD_THRESHOLD ? Number(process.env.VAD_THRESHOLD) : 0.5;

// ricky0123/vad's real defaults (minSpeechMs:400, redemptionMs:1400,
// preSpeechPadMs:800) are tuned for continuous multi-second conversational
// speech in a live mic stream — measured (see history.json) to reject ~40%
// of these ~1-2s isolated-monosyllable clips outright as misfires, which
// erased the naive threshold's one clear win (Noisy-condition accuracy).
// These candidates rescale each duration toward this corpus's actual
// speech-span lengths (commonly 300-700ms within a 1-2s clip, per direct
// inspection of real Silero probability curves) rather than continuous
// speech, while keeping the hysteresis MECHANISM (separate rise/fall
// thresholds, redemption grace, padding, misfire rejection) intact.
const HYSTERESIS_CANDIDATES = [
  { label: 'ricky0123 defaults', opts: {} },
  {
    label: 'short-duration (same 0.3/0.25 thresholds, ~1/5 the durations)',
    opts: { minSpeechMs: 100, redemptionMs: 250, preSpeechPadMs: 150 }
  },
  {
    // the winner: clears the decision gate outright — see silero-vad.mjs's
    // MONOSYLLABLE_HYSTERESIS_OPTIONS for the full result and rationale.
    label: 'short-duration + lower thresholds (MONOSYLLABLE_HYSTERESIS_OPTIONS)',
    opts: MONOSYLLABLE_HYSTERESIS_OPTIONS
  },
  {
    label: 'shortest-duration + lower thresholds',
    opts: { positiveSpeechThreshold: 0.2, negativeSpeechThreshold: 0.15, minSpeechMs: 50, redemptionMs: 120, preSpeechPadMs: 100 }
  }
];

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
  const hystArms = HYSTERESIS_CANDIDATES.map(c => ({ ...c, records: [] }));
  let i = 0;
  for (const item of items) {
    i++;
    if (i % 50 === 0) console.log(`  ${i}/${items.length}...`);
    const target = item.tones.length ? item.tones[0] : 1;
    const rec = { token: item.token, speaker: item.speaker, condition: item.condition, tone: target };

    const buf = readFileSync(item.path);
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    const sound = quiet(() => praat.readAudio(ab, '/tmp/clip.mp3'));
    if (!sound) {
      baseline.push({ ...rec, voiced: false, reason: 'load-failed' });
      silero.push({ ...rec, voiced: false, reason: 'load-failed' });
      hystArms.forEach(a => a.records.push({ ...rec, voiced: false, reason: 'load-failed' }));
      continue;
    }
    const analysis = parseAnalysisOutput(quiet(() => praat.run(buildAnalysisScript(sound.id))));
    quiet(() => praat.removeAll());

    const prep = prepUtterance(analysis);
    if (!prep.rawSpan) {
      baseline.push({ ...rec, voiced: false, reason: 'no-voice' });
      silero.push({ ...rec, voiced: false, reason: 'no-voice' });
      hystArms.forEach(a => a.records.push({ ...rec, voiced: false, reason: 'no-voice' }));
      continue;
    }

    baseline.push({ ...rec, ...scoreSpan(prep, prep.speechSpan, target) });

    try {
      const pcm16k = decodeToPcm(item.path, VAD_SAMPLE_RATE);
      const probs = await runSileroVad(vad, pcm16k);
      const maxFrame = analysis.pitch.n - 1;

      const timeSpan = probsToSpan(probs, VAD_THRESHOLD);
      if (!timeSpan) {
        silero.push({ ...rec, voiced: false, reason: 'vad-no-speech' });
      } else {
        const frameSpan = secondsToFrameSpan(timeSpan.startSec, timeSpan.endSec, analysis.pitch.x1, analysis.pitch.dx, maxFrame);
        silero.push({ ...rec, ...scoreSpan(prep, frameSpan, target) });
      }

      for (const arm of hystArms) {
        const hystSpan = probsToSpanHysteresis(probs, arm.opts);
        if (!hystSpan) {
          arm.records.push({ ...rec, voiced: false, reason: 'vad-no-speech' });
        } else {
          const frameSpan = secondsToFrameSpan(hystSpan.startSec, hystSpan.endSec, analysis.pitch.x1, analysis.pitch.dx, maxFrame);
          arm.records.push({ ...rec, ...scoreSpan(prep, frameSpan, target) });
        }
      }
    } catch (e) {
      const err = { ...rec, voiced: false, reason: 'error:' + (e.message || '').slice(0, 60) };
      silero.push(err);
      hystArms.forEach(a => a.records.push(err));
    }
  }

  console.log('\nOverall:');
  summarize(baseline, 'baseline (findSpeechSpan)');
  summarize(silero, `Silero VAD span (naive threshold=${VAD_THRESHOLD})`);
  for (const arm of hystArms) summarize(arm.records, `hysteresis: ${arm.label}`);

  for (const cond of ['Noisy', 'Quiet']) {
    console.log(`\n${cond}:`);
    summarize(baseline.filter(r => r.condition === cond), 'baseline');
    summarize(silero.filter(r => r.condition === cond), 'Silero VAD span (naive)');
    for (const arm of hystArms) summarize(arm.records.filter(r => r.condition === cond), `hysteresis: ${arm.label}`);
  }
  for (const sp of [...new Set(items.map(m => m.speaker))]) {
    for (const cond of ['Noisy', 'Quiet']) {
      const b = baseline.filter(r => r.speaker === sp && r.condition === cond);
      if (!b.length) continue;
      console.log(`\n${sp}/${cond}:`);
      summarize(b, 'baseline');
      summarize(silero.filter(r => r.speaker === sp && r.condition === cond), 'Silero VAD span (naive)');
      for (const arm of hystArms) summarize(arm.records.filter(r => r.speaker === sp && r.condition === cond), `hysteresis: ${arm.label}`);
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
  logGroup(silero, `silero-vad-experiment: Silero VAD span (naive threshold=${VAD_THRESHOLD})`);
  for (const arm of hystArms) logGroup(arm.records, `silero-vad-experiment: hysteresis (${arm.label})`);
  printComparison('toneaudio-single', 10);
}

main().catch(err => { console.error(err); process.exit(2); });
