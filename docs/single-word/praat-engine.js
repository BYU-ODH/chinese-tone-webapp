/*
 * Praat-WASM analysis engine.
 *
 * - Boots praat-wasm in a Web Worker (loaded from CDN via a same-origin
 *   bootstrap blob to satisfy the Worker same-origin requirement).
 * - For each recording, runs a single Praat script that emits structured
 *   key/value output for pitch, intensity, HNR, jitter, and duration.
 *
 * Parameters are tuned for tone analysis across child and adult voices:
 *   pitch floor 75 Hz   (catches T3 dips that can drop into the 90–110 Hz
 *                        region for kids and below 80 Hz for adult males)
 *   pitch ceiling 600 Hz (covers excited child T1 / T4 onsets)
 *   voicing threshold 0.30 (default 0.45 routinely drops creaky T3 frames
 *                           and breaks the contour mid-syllable)
 *   silence threshold 0.01 (default 0.03 cuts low-energy creaky regions)
 */

const PRAAT_VERSION = '6.4.6200';
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
 * Praat script: given a selected Sound, emit structured analysis output.
 * Output format is a sequence of key/value lines and "values...endvalues"
 * blocks, parsed by parseAnalysisOutput().
 */
function buildAnalysisScript (soundId) {
  return `
writeInfoLine: "BEGIN"
selectObject: ${soundId}
duration = Get total duration
sr = Get sampling frequency
appendInfoLine: "DURATION ", fixed$(duration, 6)
appendInfoLine: "SAMPLERATE ", fixed$(sr, 1)

# --- Pitch (autocorrelation; permissive voicing for creaky T3) ---
# Args: timeStep, floor, maxCandidates, veryAccurate, silenceThreshold,
#       voicingThreshold, octaveCost, octaveJumpCost, voicedUnvoicedCost,
#       ceiling
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

# --- Intensity ---
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

# --- Harmonicity (HNR) ---
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

# --- Jitter (local) via PointProcess ---
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

/**
 * Parse the structured info-window output produced by buildAnalysisScript.
 * Returns a numeric struct or throws on malformed input.
 */
function parseAnalysisOutput (text) {
  const lines = text.split('\n').map(l => l.trim());
  const out = {
    duration: 0,
    sampleRate: 0,
    pitch: { n: 0, dx: 0, x1: 0, values: [] },
    intensity: { n: 0, dx: 0, x1: 0, values: [] },
    hnrMean: -99,
    jitter: -1
  };

  let mode = null;       // current block: 'PITCH' | 'INTENSITY' | null
  let inValues = false;
  let block = null;

  for (const line of lines) {
    if (!line) continue;
    if (line === 'BEGIN' || line === 'END') continue;

    if (line === 'PITCH') { mode = 'PITCH'; block = out.pitch; continue; }
    if (line === 'INTENSITY') { mode = 'INTENSITY'; block = out.intensity; continue; }
    if (line === 'values') { inValues = true; continue; }
    if (line === 'endvalues') { inValues = false; mode = null; block = null; continue; }

    if (inValues && block) {
      if (line === 'u' || line === '--undefined--') {
        block.values.push(NaN);
      } else {
        block.values.push(parseFloat(line));
      }
      continue;
    }

    // Key-value lines.
    const sp = line.indexOf(' ');
    if (sp < 0) continue;
    const key = line.slice(0, sp);
    const val = line.slice(sp + 1).trim();
    const num = parseFloat(val);

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
 * Produce time-aligned arrays from a sampled block (pitch or intensity).
 * Returns { times, values } where times[i] = x1 + i*dx.
 */
export function expand (block) {
  const { n, dx, x1, values } = block;
  const times = new Float64Array(n);
  for (let i = 0; i < n; i++) times[i] = x1 + i * dx;
  return { times, values };
}
