/*
 * silero-vad.mjs — Node-callable wrapper around Silero VAD v5, run via
 * onnxruntime-web's WASM backend (no native onnxruntime-node binary
 * needed — see the feasibility notes in scripts/experiment-silero-vad.mjs's
 * header for why that path was avoided in this environment).
 *
 * Two bugs fixed by comparing against ricky0123/vad's reference
 * implementation (packages/web/src/models/v5.ts,
 * packages/web/src/non-real-time-vad.ts) — the actively-maintained JS
 * wrapper the Silero ecosystem points to:
 *
 *   1. Wrong windowing protocol. This file previously prepended a
 *      64-sample "context" window carried from the previous chunk (a
 *      448-sample effective hop into a 512-sample window), copying the
 *      official utils_vad.py *legacy/v4* reference wrapper. v5's own
 *      reference wrapper feeds disjoint, non-overlapping 512-sample
 *      frames directly with NO context concatenation (that concept is
 *      legacy/v4-only, which also uses a completely different h/c state
 *      pair instead of v5's single `state` tensor).
 *   2. Wrong model weights. session.inputNames/outputNames confirmed the
 *      downloaded silero_vad.onnx WAS v5-shaped (same tensor names, same
 *      STFT+If-node architecture) and matched ricky0123/vad's
 *      silero_vad_v5.onnx byte-for-byte in size (2,327,524 bytes) — but
 *      not in content: SHA256 differed, with ~1.77M of 2.3M bytes
 *      diverging. Same architecture, different (wrong/untrained-for-this-
 *      export) trained weights. Fix #1 alone did not resolve the
 *      near-zero-probability symptom; swapping in ricky0123/vad's actual
 *      model file did. Now cached at .tone-cache/silero-vad/silero_vad.onnx
 *      (git-ignored, mirrors corpus-eval.mjs's external-asset convention
 *      for praat-wasm) instead of a session-scratch path.
 *
 * Verified post-fix on a real ToneAudio monosyllable clip: a clean
 * silence→speech→silence probability curve peaking at 0.95, not a flat
 * ~0.001 regardless of content.
 */
import { readFileSync } from 'node:fs';

const WINDOW_SAMPLES = 512;       // disjoint samples per model call — no overlap for v5
const SAMPLE_RATE = 16000;
const STATE_SHAPE = [2, 1, 128];

export async function loadSileroVad ({ ortDir, modelPath }) {
  const { default: ort } = await import(`${ortDir}/ort.wasm.min.js`);
  ort.env.wasm.wasmPaths = `${ortDir}/`;
  const modelBytes = readFileSync(modelPath);
  const session = await ort.InferenceSession.create(new Uint8Array(modelBytes));
  return { ort, session };
}

/**
 * Run Silero VAD over a full clip's Float32 PCM (expected @ 16kHz mono).
 * Disjoint, non-overlapping 512-sample windows (per v5's reference
 * wrapper — no context concatenation), recurrent state carried between
 * windows, reset fresh per clip (no cross-clip leakage).
 *
 * @returns {number[]} per-window speech probability, one per WINDOW_SAMPLES hop
 */
export async function runSileroVad ({ ort, session }, pcm16k) {
  const { Tensor } = ort;
  let state = new Float32Array(STATE_SHAPE[0] * STATE_SHAPE[1] * STATE_SHAPE[2]);
  const srTensor = new Tensor('int64', BigInt64Array.from([BigInt(SAMPLE_RATE)]), [1]);
  const probs = [];
  const window = new Float32Array(WINDOW_SAMPLES);

  for (let i = 0; i < pcm16k.length; i += WINDOW_SAMPLES) {
    const n = Math.min(WINDOW_SAMPLES, pcm16k.length - i);
    window.fill(0);
    window.set(pcm16k.subarray(i, i + n), 0);

    const feeds = {
      input: new Tensor('float32', window, [1, WINDOW_SAMPLES]),
      state: new Tensor('float32', state, STATE_SHAPE),
      sr: srTensor
    };
    const results = await session.run(feeds);
    probs.push(results.output.data[0]);
    // Float32Array.from() copies — results.stateN.data may be a view onto
    // WASM memory that the NEXT session.run() call is free to overwrite,
    // which would silently make every chunk see a stale/zeroed state
    // (this was exactly the earlier bug: a flat, unchanging near-zero
    // probability across every chunk of a real speech clip, regardless
    // of content).
    state = Float32Array.from(results.stateN.data);
  }
  return probs;
}

/**
 * Collapse per-chunk speech probabilities into a single {startSec,endSec}
 * speech span — the first and last chunk clearing `threshold` — mirroring
 * findSpeechSpan()'s single-contiguous-span contract. Returns null if no
 * chunk clears the threshold at all.
 */
export function probsToSpan (probs, threshold = 0.5) {
  let first = -1, last = -1;
  for (let i = 0; i < probs.length; i++) {
    if (probs[i] >= threshold) {
      if (first < 0) first = i;
      last = i;
    }
  }
  if (first < 0) return null;
  const hopSec = WINDOW_SAMPLES / SAMPLE_RATE;
  return { startSec: first * hopSec, endSec: (last + 1) * hopSec };
}

// ricky0123/vad's defaultFrameProcessorOptions (packages/web/src/frame-processor.ts)
// — this is their tuned production default, not a guess. Kept as-is (not
// overwritten by the tuning below) as a faithful reference point — it's
// tuned for continuous multi-second conversational speech in a live mic
// stream, and measured (scripts/results/history.json,
// "silero-vad-experiment: hysteresis (ricky0123 defaults)") to reject ~40%
// of ~1-2s isolated-monosyllable clips outright as misfires: 46.3% overall
// accuracy at 59.3% coverage, WORSE than doing nothing (baseline 53.7% at
// 98.4% coverage) and worse than even the naive single-threshold cut.
export const DEFAULT_HYSTERESIS_OPTIONS = {
  positiveSpeechThreshold: 0.3,
  negativeSpeechThreshold: 0.25,
  redemptionMs: 1400,
  preSpeechPadMs: 800,
  minSpeechMs: 400
};

// Retuned for THIS corpus's clip length (~1-2s, with real speech spans
// commonly 300-700ms — see scripts/experiment-silero-vad.mjs's
// HYSTERESIS_CANDIDATES sweep for the full comparison). Durations rescaled
// to ~1/5 of ricky0123's continuous-speech defaults, thresholds lowered to
// 0.2/0.15 (matching the standalone naive-threshold sweep's own finding
// that lower absolute thresholds help this corpus). Full-corpus result
// (248 ToneAudio single-word clips): 55.2% overall accuracy at 96.4%
// coverage, vs baseline's 53.7% at 98.4% — the first configuration in this
// investigation to beat baseline overall AND clear Stage 2's decision gate
// (Noisy 31.6%→36.8%, Quiet 63.7%→63.8%) with no real regression in any
// speaker×condition slice.
export const MONOSYLLABLE_HYSTERESIS_OPTIONS = {
  positiveSpeechThreshold: 0.2,
  negativeSpeechThreshold: 0.15,
  redemptionMs: 250,
  preSpeechPadMs: 150,
  minSpeechMs: 100
};

/**
 * Port of ricky0123/vad's FrameProcessor state machine (packages/web/src/
 * frame-processor.ts) onto a precomputed probs array, rather than
 * probsToSpan()'s naive single-threshold first/last cut. Adds three things
 * FrameProcessor gets that a flat threshold doesn't:
 *   - hysteresis: a separate, lower threshold to END a speech segment than
 *     to START one, so brief dips don't fragment one utterance.
 *   - redemption grace: negativeSpeechThreshold must hold for
 *     `redemptionMs` straight before a segment is considered over, so a
 *     momentary dip mid-word doesn't truncate it. Per FrameProcessor's own
 *     behavior, the whole grace period's frames stay IN the segment (the
 *     cut isn't backdated to before the dip).
 *   - preSpeechPadMs of lookback prepended to the segment start, and a
 *     minSpeechMs floor below which a segment is discarded as a misfire
 *     (VADMisfire) rather than returned.
 * Multiple qualifying segments (rare for a single-word clip, but possible)
 * are unioned into one {startSec,endSec} span, mirroring probsToSpan()'s
 * single-span contract. Returns null if no segment survives.
 */
export function probsToSpanHysteresis (probs, options = {}) {
  const opts = { ...DEFAULT_HYSTERESIS_OPTIONS, ...options };
  const hopMs = 1000 * WINDOW_SAMPLES / SAMPLE_RATE;
  const redemptionFrames = Math.floor(opts.redemptionMs / hopMs);
  const preSpeechPadFrames = Math.floor(opts.preSpeechPadMs / hopMs);
  const minSpeechFrames = Math.floor(opts.minSpeechMs / hopMs);

  const segments = [];
  let speaking = false;
  let segStart = -1;
  let speechFrameCount = 0;
  let redemptionCounter = 0;
  let padBuffer = [];

  for (let i = 0; i < probs.length; i++) {
    const p = probs[i];
    if (p >= opts.positiveSpeechThreshold) {
      speechFrameCount++;
      redemptionCounter = 0;
      if (!speaking) {
        speaking = true;
        segStart = padBuffer.length ? padBuffer[0] : i;
      }
    }
    if (p < opts.negativeSpeechThreshold && speaking) {
      redemptionCounter++;
      if (redemptionCounter >= redemptionFrames) {
        if (speechFrameCount >= minSpeechFrames) segments.push({ start: segStart, end: i });
        speaking = false; segStart = -1; speechFrameCount = 0; redemptionCounter = 0; padBuffer = [];
      }
    }
    if (!speaking) {
      padBuffer.push(i);
      if (padBuffer.length > preSpeechPadFrames) padBuffer.shift();
    }
  }
  if (speaking && speechFrameCount >= minSpeechFrames) {
    segments.push({ start: segStart, end: probs.length - 1 });
  }

  if (!segments.length) return null;
  const hopSec = WINDOW_SAMPLES / SAMPLE_RATE;
  const first = segments[0].start;
  const last = segments[segments.length - 1].end;
  return { startSec: first * hopSec, endSec: (last + 1) * hopSec };
}
