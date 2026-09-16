/*
 * Praat analysis script + output parser — the single source of truth shared by
 * the browser engine (praat-engine.js, which runs it in a Web Worker) and the
 * headless Node tests (test_pipeline.mjs, test_realaudio.mjs, which run it via
 * praat-wasm directly). These are pure functions with no worker/DOM deps.
 *
 * Parameters are tuned for tone analysis across child and adult voices:
 *   pitch floor 75 Hz   (catches T3 dips that can drop into the 90–110 Hz
 *                        region for kids and below 80 Hz for adult males)
 *   pitch ceiling 600 Hz (covers excited child T1 / T4 onsets)
 *   voicing threshold 0.30 (default 0.45 routinely drops creaky T3 frames
 *                           and breaks the contour mid-syllable)
 *   silence threshold 0.01 (default 0.03 cuts low-energy creaky regions)
 *
 * Does NOT compute jitter: it was parsed into the output struct but never
 * consumed by classify()/app.js/viz.js — pure latency (a full PointProcess +
 * period-counting pass) for zero downstream signal. Dropped 2026-07-22.
 */

/*
 * Pitch tracking range, shared by every Praat pass in this file. The
 * resynthesis pass (buildResynthesisScript) MUST use the same range as the
 * analysis pass: it re-derives the pulse train that carries the corrected
 * contour, and a mismatch there would mean the pitch we measured and the
 * pitch we can re-impose disagree at exactly the edges of the range (creaky
 * T3 at the floor, excited T1/T4 onsets at the ceiling) where tone feedback
 * matters most.
 */
export const PITCH_FLOOR_HZ = 75;
export const PITCH_CEILING_HZ = 600;

/**
 * Praat script: given a selected Sound, emit structured analysis output.
 * Output format is a sequence of key/value lines and "values...endvalues"
 * blocks, parsed by parseAnalysisOutput().
 */
export function buildAnalysisScript (soundId) {
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
To Pitch (ac): 0.005, ${PITCH_FLOOR_HZ}, 15, "no", 0.01, 0.30, 0.01, 0.35, 0.14, ${PITCH_CEILING_HZ}
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
To Intensity: ${PITCH_FLOOR_HZ}, 0.005, "yes"
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
# Time step matches pitch (0.005) so the per-frame contour aligns with F0.
selectObject: ${soundId}
To Harmonicity (cc): 0.005, ${PITCH_FLOOR_HZ}, 0.1, 1.0
hnrId = selected("Harmonicity")
hnrMean = Get mean: 0, 0
if hnrMean = undefined
    appendInfoLine: "HNR_MEAN -99"
else
    appendInfoLine: "HNR_MEAN ", fixed$(hnrMean, 3)
endif
# Per-frame HNR contour, used to veto low-periodicity (consonant) frames.
nHnrFrames = Get number of frames
hnrDx = Get time step
hnrX1 = Get time from frame number: 1
appendInfoLine: "HARMONICITY"
appendInfoLine: "n ", nHnrFrames
appendInfoLine: "dx ", fixed$(hnrDx, 6)
appendInfoLine: "x1 ", fixed$(hnrX1, 6)
appendInfoLine: "values"
for i to nHnrFrames
    h = Get value in frame: i
    # Praat stores undefined/unvoiced harmonicity as a large negative sentinel.
    if h = undefined or h < -100
        appendInfoLine: "u"
    else
        appendInfoLine: fixed$(h, 3)
    endif
endfor
appendInfoLine: "endvalues"
removeObject: hnrId

appendInfoLine: "END"
`;
}

/**
 * Parse the structured info-window output produced by buildAnalysisScript.
 * Returns a numeric struct or throws on malformed input.
 */
export function parseAnalysisOutput (text) {
  const lines = text.split('\n').map(l => l.trim());
  const out = {
    duration: 0,
    sampleRate: 0,
    pitch: { n: 0, dx: 0, x1: 0, values: [] },
    intensity: { n: 0, dx: 0, x1: 0, values: [] },
    harmonicity: { n: 0, dx: 0, x1: 0, values: [] },
    hnrMean: -99
  };

  let mode = null;       // current block: 'PITCH' | 'INTENSITY' | 'HARMONICITY' | null
  let inValues = false;
  let block = null;

  for (const line of lines) {
    if (!line) continue;
    if (line === 'BEGIN' || line === 'END') continue;

    if (line === 'PITCH') { mode = 'PITCH'; block = out.pitch; continue; }
    if (line === 'INTENSITY') { mode = 'INTENSITY'; block = out.intensity; continue; }
    if (line === 'HARMONICITY') { mode = 'HARMONICITY'; block = out.harmonicity; continue; }
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

    if (mode === 'PITCH' || mode === 'INTENSITY' || mode === 'HARMONICITY') {
      if (key === 'n') block.n = num | 0;
      else if (key === 'dx') block.dx = num;
      else if (key === 'x1') block.x1 = num;
      continue;
    }

    if (key === 'DURATION') out.duration = num;
    else if (key === 'SAMPLERATE') out.sampleRate = num;
    else if (key === 'HNR_MEAN') out.hnrMean = num;
  }

  return out;
}

/**
 * Praat script: impose an explicit pitch contour on a Sound and resynthesize,
 * writing the result to `outPath` inside the WASM filesystem.
 *
 * This is PSOLA pitch manipulation, not synthesis: the Manipulation object
 * decomposes the recording into a pulse train plus the original spectral
 * envelope, the pulse train is retimed to follow the new PitchTier, and
 * overlap-add puts it back together. The learner's own voice — timbre,
 * timing, loudness, every segmental detail — survives untouched; only F0
 * moves. That is the whole point of the feature: "this is what YOU sound
 * like when the tones are right", not "this is what a native speaker sounds
 * like", which the learner already gets from a reference recording and
 * consistently fails to map onto their own voice.
 *
 * Unvoiced stretches stay unvoiced regardless of what the tier says over
 * them: there are no pulses there to retime. So the point list can (and
 * does) span the whole utterance without having to carve consonants out.
 *
 * @param {number} soundId   Praat object id of the loaded Sound
 * @param {{time:number, hz:number}[]} points  the target contour, in time
 *   order. Praat interpolates linearly between points, so a dense list
 *   (one per analysis frame — see pitch-correct.js) reproduces the curve
 *   exactly rather than approximating it with line segments.
 * @param {string} outPath   WASM-filesystem path for the resulting WAV
 */
export function buildResynthesisScript (soundId, points, outPath = '/tmp/corrected.wav') {
  if (!Array.isArray(points) || points.length < 2) {
    throw new Error('buildResynthesisScript: need at least two pitch points.');
  }
  const addPoints = points
    .map(p => `Add point: ${p.time.toFixed(6)}, ${p.hz.toFixed(3)}`)
    .join('\n');

  return `
writeInfoLine: "BEGIN"
selectObject: ${soundId}
duration = Get total duration

# Manipulation's own pitch range must match the analysis pass (see the
# PITCH_FLOOR_HZ / PITCH_CEILING_HZ comment above).
To Manipulation: 0.01, ${PITCH_FLOOR_HZ}, ${PITCH_CEILING_HZ}
manId = selected("Manipulation")

Create PitchTier: "corrected", 0, duration
tierId = selected("PitchTier")
${addPoints}

selectObject: manId
plusObject: tierId
Replace pitch tier

selectObject: manId
Get resynthesis (overlap-add)
outId = selected("Sound")
Save as WAV file: ${JSON.stringify(outPath)}

removeObject: manId
removeObject: tierId
removeObject: outId
appendInfoLine: "END"
`;
}
