/*
 * Praat-WASM analysis engine.
 *
 * - Boots praat-wasm in a Web Worker (loaded from CDN via a same-origin
 *   bootstrap blob to satisfy the Worker same-origin requirement).
 * - For each recording, runs a single Praat script that emits structured
 *   key/value output for pitch, intensity, HNR, and duration.
 *
 * Parameters are tuned for tone analysis across child and adult voices:
 *   pitch floor 75 Hz   (catches T3 dips that can drop into the 90–110 Hz
 *                        region for kids and below 80 Hz for adult males)
 *   pitch ceiling 600 Hz (covers excited child T1 / T4 onsets)
 *   voicing threshold 0.30 (default 0.45 routinely drops creaky T3 frames
 *                           and breaks the contour mid-syllable)
 *   silence threshold 0.01 (default 0.03 cuts low-energy creaky regions)
 */

import {
  buildAnalysisScript, parseAnalysisOutput, buildResynthesisScript
} from './praat-analysis.js';

const PRAAT_VERSION = '6.4.6200';
// Fixed path inside the WASM filesystem for resynthesis output. Reused
// rather than uniquified so repeated corrections overwrite one file
// instead of growing MEMFS by a WAV per click for the whole session.
const RESYNTH_PATH = '/tmp/corrected.wav';
const CDN_BASE = `https://cdn.jsdelivr.net/npm/praat-wasm@${PRAAT_VERSION}`;

let workerPromise = null;

async function getWorker () {
  if (workerPromise) return workerPromise;

  workerPromise = (async () => {
    const { createPraatWorker } = await import(
      /* @vite-ignore */ `${CDN_BASE}/js/worker-client.mjs`
    );
    const workerModuleUrl = `${CDN_BASE}/js/worker.mjs`;
    const bootstrap = `import ${JSON.stringify(workerModuleUrl)};\n`;
    const bootstrapUrl = URL.createObjectURL(
      new Blob([bootstrap], { type: 'text/javascript' })
    );
    try {
      const worker = await createPraatWorker(bootstrapUrl);
      // Pre-warm: a no-op call ensures the WASM module is fully instantiated
      // and JIT-compiled before the user's first recording.
      await worker.run('writeInfoLine: "ready"');
      return worker;
    } finally {
      URL.revokeObjectURL(bootstrapUrl);
    }
  })().catch(err => {
    workerPromise = null;
    throw err;
  });

  return workerPromise;
}

/**
 * Initialize the engine. Resolves once Praat-WASM is loaded and ready.
 */
export async function ensureReady () {
  await getWorker();
}

/**
 * Analyze a recorded WAV ArrayBuffer. Returns a struct with pitch contour
 * (Hz, NaN for unvoiced), intensity contour (dB), and voice-quality scalars.
 *
 * The buffer is transferred to the worker (zero-copy).
 */
export async function analyzeWav (wavBuffer) {
  const worker = await getWorker();
  const sound = await worker.readAudio(wavBuffer, '/tmp/in.wav');
  if (!sound || sound.id == null) {
    throw new Error('Praat could not load the recorded audio.');
  }
  try {
    const script = buildAnalysisScript(sound.id);
    const text = await worker.run(script);
    return parseAnalysisOutput(text);
  } finally {
    // Clean up so objects don't accumulate across recordings.
    await worker.removeAll();
  }
}

/**
 * Re-voice a recording onto an explicit pitch contour and return the result
 * as a WAV ArrayBuffer. `points` is [{time, hz}, ...] in time order — see
 * pitch-correct.js, which builds it from a scored utterance.
 *
 * Nothing but F0 changes: this is PSOLA resynthesis of the learner's own
 * audio (see buildResynthesisScript), so the returned WAV is still their
 * voice, their timing and their words.
 *
 * As with analyzeWav, `wavBuffer` is TRANSFERRED to the worker and is
 * detached on this thread afterwards — pass a buffer you don't still need.
 */
export async function resynthesizeWithPitch (wavBuffer, points) {
  const worker = await getWorker();
  const sound = await worker.readAudio(wavBuffer, '/tmp/resynth-in.wav');
  if (!sound || sound.id == null) {
    throw new Error('Praat could not load the recorded audio.');
  }
  try {
    await worker.run(buildResynthesisScript(sound.id, points, RESYNTH_PATH));
    const bytes = await worker.getFile(RESYNTH_PATH);
    if (!bytes || bytes.byteLength === 0) {
      throw new Error('Praat produced no corrected audio.');
    }
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  } finally {
    await worker.removeAll();
  }
}

/**
 * Produce time-aligned arrays from a sampled block (pitch or intensity).
 * Returns { times, values } where times[i] = x1 + i*dx.
 */
export function expand (block) {
  const { n, dx, x1, values } = block;
  const times = new Float64Array(n);
  for (let i = 0; i < n; i++) times[i] = x1 + i * dx;
  return { times, values };
}
