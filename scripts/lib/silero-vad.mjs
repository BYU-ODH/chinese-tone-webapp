/*
 * silero-vad.mjs — Node-callable wrapper around Silero VAD (v5 protocol),
 * run via onnxruntime-web's WASM backend (no native onnxruntime-node
 * binary needed — see the feasibility notes in
 * scripts/experiment-silero-vad.mjs's header for why that path was
 * avoided in this environment).
 *
 * CURRENTLY BLOCKED — produces implausible output, not yet trustworthy.
 * The model loads correctly and DOES respond differently to different
 * inputs (ruling out a totally frozen/uninitialized session), but every
 * input tried — real recorded speech, loud synthetic tones, loud white
 * noise, all-zero silence — comes back with a near-zero speech
 * probability (<0.003), including the objectively loudest chunk of a
 * real spoken-word recording. Ruled out so far, each verified rather than
 * assumed:
 *   - stale-buffer bug: results.stateN.data could be a view onto WASM
 *     memory the next session.run() is free to overwrite. Fixed with
 *     Float32Array.from() to force a copy — no change in output.
 *   - input scale: tried raw [-1,1] float32 (Silero's documented
 *     convention) and x32768-scaled — no meaningful change.
 *   - `sr` tensor rank: tried scalar (shape []) and rank-1 (shape [1]) —
 *     identical output either way.
 *   - missing context window: the official utils_vad.py wrapper prepends
 *     a 64-sample context carried from the previous window (effective
 *     448-sample hop into a 512-sample window, not 512 disjoint samples
 *     as first implemented) — implemented that sliding-window protocol
 *     exactly; no change in output.
 * No Python/torch/onnxruntime available in this environment to cross-
 * check against the official reference implementation directly, which
 * would be the fastest way to tell whether this is a remaining subtlety
 * in this JS reimplementation or an issue with this specific downloaded
 * model file (verified correct file size and valid ONNX/protobuf header,
 * so not a corrupted download). Model I/O shapes below ARE confirmed
 * correct via the session's own reported input/output names — only the
 * numeric results are in question.
 */
import { readFileSync } from 'node:fs';

const WINDOW_SAMPLES = 512;       // total samples per model call (context + new)
const CONTEXT_SAMPLES = 64;       // per the official utils_vad.py OnnxWrapper, at 16kHz
const NEW_SAMPLES = WINDOW_SAMPLES - CONTEXT_SAMPLES; // 448 — the real hop per step
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
 * Sliding window with a 64-sample context carried from the tail of the
 * previous window (per the official reference wrapper), recurrent state
 * carried between windows, both reset fresh per clip (no cross-clip
 * leakage). See this file's header: despite this being the verified-
 * correct protocol, output is not yet trustworthy — treat with caution.
 *
 * @returns {number[]} per-window speech probability (effective hop: NEW_SAMPLES, not WINDOW_SAMPLES)
 */
export async function runSileroVad ({ ort, session }, pcm16k) {
  const { Tensor } = ort;
  let state = new Float32Array(STATE_SHAPE[0] * STATE_SHAPE[1] * STATE_SHAPE[2]);
  let context = new Float32Array(CONTEXT_SAMPLES); // zeros at clip start
  const srTensor = new Tensor('int64', BigInt64Array.from([BigInt(SAMPLE_RATE)]), []);
  const probs = [];
  const window = new Float32Array(WINDOW_SAMPLES);

  for (let i = 0; i < pcm16k.length; i += NEW_SAMPLES) {
    const n = Math.min(NEW_SAMPLES, pcm16k.length - i);
    window.fill(0);
    window.set(context, 0);
    window.set(pcm16k.subarray(i, i + n), CONTEXT_SAMPLES);

    const feeds = {
      input: new Tensor('float32', window, [1, WINDOW_SAMPLES]),
      state: new Tensor('float32', state, STATE_SHAPE),
      sr: srTensor
    };
    const results = await session.run(feeds);
    context = window.slice(NEW_SAMPLES); // last CONTEXT_SAMPLES of this window feed the next one
    probs.push(results.output.data[0]);
    // Float32Array.from() copies — results.stateN.data may be a view onto
    // WASM memory that the NEXT session.run() call is free to overwrite,
    // which would silently make every chunk see a stale/zeroed state
    // (this was exactly the bug: a flat, unchanging near-zero probability
    // across every chunk of a real speech clip, regardless of content).
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
  const hopSec = NEW_SAMPLES / SAMPLE_RATE; // effective hop per step, not the full window size
  return { startSec: first * hopSec, endSec: (last + 1) * hopSec };
}
