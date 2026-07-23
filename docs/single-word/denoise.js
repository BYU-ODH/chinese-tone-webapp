/*
 * RNNoise denoising, applied to every recording before analysis.
 *
 * Decision (Stage 2 Track B, measured not assumed — see
 * scripts/experiment-rnnoise.mjs and scripts/results/history.json for the
 * full A/B this is based on): on the real ToneAudio corpus, RNNoise raised
 * Noisy-condition tone accuracy by +13.3pp (31.6%→44.9%) while leaving
 * Quiet essentially unchanged (63.7%→63.2%). Since it doesn't regress the
 * clean case and the app has no way to know at runtime whether a given
 * recording is noisy, denoising is applied unconditionally rather than
 * gated on a detected condition.
 *
 * Loaded from CDN on the MAIN thread, not a Worker: a full utterance's
 * worth of frames denoises in single-digit milliseconds (measured during
 * the eval spike), well under anything perceptible as lag. Praat still
 * runs in its own Worker (see praat-engine.js) — this is a separate,
 * much smaller WASM module.
 *
 * If the CDN load fails (network hiccup, ad-blocker, etc.), denoising is
 * treated as an optional enhancement, not a hard requirement: callers
 * should fall back to scoring the original, un-denoised audio rather than
 * blocking practice over it — see ensureDenoiseReady()'s doc comment.
 */

const RNNOISE_VERSION = '2025.1.5';
const CDN_URL = `https://cdn.jsdelivr.net/npm/@shiguredo/rnnoise-wasm@${RNNOISE_VERSION}/dist/rnnoise.js`;

// RNNoise's model was trained at 48kHz. Denoising still runs at other
// sample rates (no resampling is done here), but quality may degrade —
// an accepted v1 limitation, not yet measured at other rates (see
// DISCUSSION_REMINDERS.md). Most browsers/Chromebooks default the
// AudioContext to 48kHz already, so this is expected to be the common case
// in practice, not the exception.
const RNNOISE_NATIVE_RATE = 48000;
const PCM16_SCALE = 32768; // this build expects samples pre-scaled to 16-bit-PCM range

let rnnoisePromise = null;

function getRnnoise () {
  if (!rnnoisePromise) {
    rnnoisePromise = (async () => {
      const { Rnnoise } = await import(/* @vite-ignore */ CDN_URL);
      return Rnnoise.load();
    })().catch(err => { rnnoisePromise = null; throw err; });
  }
  return rnnoisePromise;
}

/**
 * Pre-warm the WASM module so the first recording doesn't pay the load
 * cost. Intentionally does NOT throw — a failure here just means the
 * first denoise() call will retry the load (and may itself fail; see
 * denoise()'s fallback contract).
 */
export async function ensureDenoiseReady () {
  try { await getRnnoise(); } catch (err) { console.warn('RNNoise pre-warm failed:', err); }
}

/**
 * Denoise Float32 PCM samples (expected range [-1, 1]), frame by frame,
 * with a fresh DenoiseState (no state leakage between recordings).
 *
 * Throws if the WASM module can't be loaded — callers should catch this
 * and fall back to the original samples (denoising is an enhancement, not
 * a hard requirement; see the file header).
 */
export async function denoise (samples, sampleRateHz) {
  if (sampleRateHz !== RNNOISE_NATIVE_RATE) {
    console.warn(`denoise(): sample rate ${sampleRateHz}Hz != RNNoise's native ${RNNOISE_NATIVE_RATE}Hz; denoising anyway, quality may be reduced.`);
  }
  const rnnoise = await getRnnoise();
  const frameSize = rnnoise.frameSize;
  const state = rnnoise.createDenoiseState();
  const out = new Float32Array(samples.length);
  const frame = new Float32Array(frameSize);
  try {
    for (let i = 0; i < samples.length; i += frameSize) {
      const n = Math.min(frameSize, samples.length - i);
      frame.fill(0);
      for (let j = 0; j < n; j++) frame[j] = samples[i + j] * PCM16_SCALE;
      state.processFrame(frame);
      for (let j = 0; j < n; j++) out[i + j] = frame[j] / PCM16_SCALE;
    }
  } finally {
    state.destroy();
  }
  return out;
}
