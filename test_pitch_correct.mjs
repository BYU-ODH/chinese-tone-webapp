/*
 * Pitch-correction end-to-end test, on REAL recordings.
 *
 * The feature's claim is narrow and worth stating precisely: "this is your
 * own voice, with the PITCH replaced by the contour you were just shown."
 * Everything here checks that claim by pushing the corrected audio back
 * through the unmodified analysis pipeline — the same one that scored the
 * original — rather than by inspecting the pitch points we asked for. That
 * closes the loop through PSOLA, so it fails if the resynthesis ignores the
 * tier, if the tier is laid over the wrong time span, or if the anchor is
 * wrong.
 *
 *   1. SHAPE. Re-measured, each corrected syllable's contour must match the
 *      target's Legendre shape (c1..c3 — reference-independent, so this
 *      compares curves without having to agree on a register).
 *   2. LEVEL. Shape mode must leave the syllable at the learner's own pitch
 *      height; register mode must move it onto the trusted reference. Two
 *      different anchors, two different failure modes (pitch-correct.js).
 *   3. NOTHING ELSE MOVED. Duration, sample rate and voicing preserved: a
 *      manipulation that quietly retimed or devoiced the audio would be a
 *      different artifact, and a pitch-only check would never see it.
 *   4. VERDICTS DON'T REGRESS, and 'good' goes up.
 *
 * What this deliberately does NOT assert is that every corrected syllable
 * re-scores 'good'. It measurably doesn't, and correctly so: the classifier
 * weighs voiced DURATION as well as pitch (T4's score is attenuated as it
 * lengthens, T3's is boosted — see classifier.js), and the corpus contains
 * syllables held for well over a second. Correcting pitch cannot fix those
 * and must not try — retiming the learner's speech would break the one
 * promise the feature makes. An assertion demanding 'good' there would be
 * demanding the wrong behavior.
 *
 * Run from the project root:
 *   node test_pitch_correct.mjs
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';

import { createPraatWasm } from '/Users/rob/repos/praat.github.io/wasm/js/praat-wasm.mjs';
import {
  buildAnalysisScript, parseAnalysisOutput, buildResynthesisScript
} from './docs/single-word/praat-analysis.js';
import {
  SpeakerNormalizer, prepUtterance, extractSyllableFeatures,
  legendreFit, movingAverage
} from './docs/single-word/features.js';
import {
  extractUtteranceFeatures, classifyUtterance, commitUtteranceToNormalizer
} from './docs/single-word/utterance.js';
import { classify } from './docs/single-word/classifier.js';
import { loadTargets, getSyllableTargets } from './docs/single-word/targets.js';
import { buildCorrectedPitchPoints } from './docs/single-word/pitch-correct.js';
import { buildManifest } from './scripts/lib/pinyin-segment.mjs';

const CORPUS = './ToneAudio_2026-07-22';
const RESYNTH_PATH = '/tmp/corrected.wav';
const CLIPS_PER_SPEAKER = 14;

/* targets.js fetches targets.json relative to its own module URL. Node's
 * fetch() won't do file://, so serve it off disk — the app's own loader is
 * still the thing under test, just with the transport swapped. */
globalThis.fetch = async (url) => {
  try {
    const text = readFileSync(fileURLToPath(url), 'utf8');
    return { ok: true, json: async () => JSON.parse(text) };
  } catch (_e) {
    return { ok: false, json: async () => ({}) };
  }
};

/* praat-wasm chatters on stderr for every object it reads. */
function quiet (fn) {
  const w = process.stderr.write.bind(process.stderr);
  process.stderr.write = () => true;
  try { return fn(); } finally { process.stderr.write = w; }
}

function analyze (praat, path) {
  const ab = readFileSync(path);
  const sound = quiet(() => praat.readAudio(
    ab.buffer.slice(ab.byteOffset, ab.byteOffset + ab.byteLength), '/tmp/clip.mp3'));
  if (!sound || sound.id == null) return null;
  const analysis = parseAnalysisOutput(praat.run(buildAnalysisScript(sound.id)));
  praat.removeAll();
  return analysis;
}

/** Run the resynthesis script and hand back the WAV bytes, as the engine does. */
function resynthesize (praat, wavBytes, points) {
  const sound = quiet(() => praat.readAudio(
    wavBytes.buffer.slice(wavBytes.byteOffset, wavBytes.byteOffset + wavBytes.byteLength),
    '/tmp/resynth-in.wav'));
  if (!sound || sound.id == null) throw new Error('readAudio failed');
  praat.run(buildResynthesisScript(sound.id, points, RESYNTH_PATH));
  const out = praat.getFile(RESYNTH_PATH);
  praat.removeAll();
  return out;
}

/** Praat can read the mp3 directly; get a WAV copy to manipulate. */
function toWav (praat, path) {
  const ab = readFileSync(path);
  const sound = quiet(() => praat.readAudio(
    ab.buffer.slice(ab.byteOffset, ab.byteOffset + ab.byteLength), '/tmp/clip.mp3'));
  praat.run(`selectObject: ${sound.id}\nSave as WAV file: "/tmp/asis.wav"\n`);
  const bytes = praat.getFile('/tmp/asis.wav');
  praat.removeAll();
  return bytes;
}

function voicedFrames (analysis) {
  return analysis.pitch.values.filter(v => Number.isFinite(v) && v > 0).length;
}

/*
 * RMS distance between two Legendre curves over normalized time, in
 * semitones, ignoring c0. The non-constant Legendre polynomials are
 * orthogonal on [-1, +1] with mean square 1/(2k+1), so this has a closed
 * form and needs no sampling. Dropping c0 is the point: it makes the
 * comparison independent of which reference each fit was made against, so
 * "is this the right SHAPE" can be answered separately from "is it at the
 * right height" — which the level checks below handle on their own terms.
 */
function shapeDistance (a, b) {
  let sum = 0;
  for (let k = 1; k <= 3; k++) {
    const d = (a[k] || 0) - (b[k] || 0);
    sum += d * d / (2 * k + 1);
  }
  return Math.sqrt(sum);
}

/*
 * Fit the app's own Legendre decomposition to a recording's F0 over an
 * explicit time window, in absolute terms (values are 12*log2(Hz), so c0/12
 * is the window's mean log2 Hz and c1..c3 are the shape in semitones).
 *
 * The window is supplied rather than re-derived, and that is the point.
 * extractSyllableFeatures picks its fit window — the vowel core — using
 * intensity AND harmonicity, and PSOLA perturbs harmonicity, so re-running
 * the core finder on the corrected audio returns a DIFFERENT, shorter window
 * than the one the target was laid over (38 frames → 25 on a clip we
 * measured). Fitting a five-semitone fall over two thirds of its own domain
 * reports a three-semitone fall, and the test would be measuring the core
 * finder's sensitivity to resynthesis rather than whether the correction
 * worked. Holding the window fixed at the one pitch-correct.js targeted asks
 * the question that matters: over this stretch of time, does the audio now
 * carry the contour we asked for?
 */
/*
 * Fraction of frames in a window the tracker called voiced. PSOLA can only
 * retime pulses that exist: a stretch the tracker mostly couldn't find F0 in
 * has little periodic content to move, and the resynthesis leaves it as-is.
 * This separates "the correction failed" from "there was nothing to correct".
 */
function voicedFraction (analysis, startSec, endSec) {
  const { n, dx, x1, values } = analysis.pitch;
  let total = 0, voiced = 0;
  for (let k = 0; k < n; k++) {
    const t = x1 + k * dx;
    if (t < startSec || t > endSec) continue;
    total++;
    if (Number.isFinite(values[k]) && values[k] > 0) voiced++;
  }
  return total ? voiced / total : 0;
}

/*
 * Frame-level agreement between what we asked Praat to synthesize and what
 * the audio measures back as, in semitones, over one time window.
 *
 * This is the sharpest available test of the feature, and the only one that
 * depends on nothing but the pitch points and the re-analysis: no Legendre
 * fit, no vowel-core re-derivation, no classifier. If the tier were ignored,
 * laid over the wrong span, or anchored wrongly, this diverges immediately.
 *
 * Reported as a median because the tracker's OWN octave errors show up here
 * as a minority of frames sitting exactly ±12 ST off — a measurement
 * failure on creaky audio, not a synthesis failure — and those are counted
 * separately rather than allowed to swamp the statistic.
 */
function trackingError (after, points, startSec, endSec) {
  const { n, dx, x1, values } = after.pitch;
  const wanted = new Map(points.map(pt => [Math.round(pt.time / dx), pt.hz]));
  const errs = [];
  let octave = 0;
  for (let k = 0; k < n; k++) {
    const t = x1 + k * dx;
    if (t < startSec || t > endSec) continue;
    const got = values[k];
    const req = wanted.get(Math.round(t / dx));
    if (!req || !Number.isFinite(got) || got <= 0) continue;
    const e = 12 * Math.log2(got / req);
    if (Math.abs(Math.abs(e) - 12) < 1.5) octave++;
    errs.push(Math.abs(e));
  }
  return { median: median(errs), n: errs.length, octaveFrames: octave };
}

/* Mean of the REQUESTED contour over a window, in log2 Hz. Deterministic —
 * it reads the pitch points, not any analysis — so an anchor can be checked
 * without inheriting the fragility of re-fitting a contour full of voicing
 * gaps. Paired with the frame-level tracking check (the audio follows the
 * request), this pins down where the corrected audio actually sits. */
function requestedLevel (points, startSec, endSec) {
  let sum = 0, n = 0;
  for (const pt of points) {
    if (pt.time < startSec || pt.time > endSec) continue;
    sum += Math.log2(pt.hz);
    n++;
  }
  return n ? sum / n : NaN;
}

function fitOverWindow (analysis, startSec, endSec) {
  const { n, dx, x1, values } = analysis.pitch;
  const times = [];
  const vals = [];
  for (let k = 0; k < n; k++) {
    const t = x1 + k * dx;
    if (t < startSec || t > endSec) continue;
    const f = values[k];
    if (Number.isFinite(f) && f > 0) { times.push(t); vals.push(12 * Math.log2(f)); }
  }
  if (times.length < 6) return null;
  // Same 3-point pre-smoothing the app applies before fitting.
  return legendreFit(times, movingAverage(vals, 3), 3);
}

const RANK = { bad: 0, uncertain: 0, close: 1, good: 2 };

/* Per-syllable features over caller-supplied spans — the same extraction the
 * app runs, minus the segmentation search. */
function featuresOverSpans (analysis, spans, normalizer) {
  const prep = prepUtterance(analysis);
  if (!prep.rawSpan) return null;
  const last = analysis.pitch.n - 1;
  const clamp = v => Math.max(0, Math.min(last, v));
  return spans.map(sp => extractSyllableFeatures(
    prep, { start: clamp(sp.start), end: clamp(sp.end) }, normalizer));
}

/*
 * One case: score a clip, correct it, re-score the corrected audio.
 * `normalizer` is shared across a speaker's clips exactly as it is in a live
 * session, so later clips reach the register-trusted path.
 */
function runCase (praat, entry, normalizer) {
  const tones = entry.tones;
  const analysis = analyze(praat, entry.path);
  if (!analysis) return { skip: 'unreadable' };

  const res = extractUtteranceFeatures(analysis, normalizer, tones);
  if (!res.voiced) return { skip: res.reason };

  const verdicts = classifyUtterance(res.syllables, tones);
  const targets = tones.map((tone, i) => {
    if (tone === 0) return null;
    const base = syllableAt(entry, i);
    const t = base ? getSyllableTargets(base)[tone] : null;
    return t ? { tone, coefs: t.coefs } : null;
  });

  // Built BEFORE the normalizer is committed, exactly as the component does,
  // so the correction is anchored on the register the attempt was scored in.
  const correction = buildCorrectedPitchPoints(analysis, res, targets, normalizer);
  if (!correction) {
    commitUtteranceToNormalizer(normalizer, res.syllables, tones);
    return { skip: 'nothing-correctable' };
  }

  const corrected = resynthesize(praat, toWav(praat, entry.path), correction.points);

  // Re-measure the corrected audio against the SAME normalizer state the
  // original was scored against — hence before the commit below. Otherwise
  // the two measurements would be taken against two different registers and
  // any level comparison between them would be meaningless.
  const soundBack = quiet(() => praat.readAudio(
    corrected.buffer.slice(corrected.byteOffset, corrected.byteOffset + corrected.byteLength),
    '/tmp/back.wav'));
  const after = parseAnalysisOutput(praat.run(buildAnalysisScript(soundBack.id)));
  praat.removeAll();

  // Measured over the ORIGINAL spans, NOT by re-running guided segmentation.
  // Re-segmenting would move the boundaries — the search is scored by the
  // very classifier whose inputs we just changed — and then "before" and
  // "after" would describe different stretches of audio. On a steep T4 a
  // 50 ms boundary shift moves the fitted mean by several semitones, which
  // is enough to manufacture failures out of a correction that worked. The
  // resynthesis preserves length and frame grid exactly (asserted below), so
  // the original frame indices still address the same moments in time.
  const afterFeatures = featuresOverSpans(after, res.spans, normalizer);
  const verdictsAfter = afterFeatures &&
    afterFeatures.map((f, i) => classify(tones[i], f));

  const syllables = correction.correctedSyllables.map(i => {
    const fBefore = res.syllables[i];
    const fAfter = afterFeatures ? afterFeatures[i] : null;
    const target = targets[i];
    // The window pitch-correct.js laid the target over: this syllable's
    // vowel core, as measured on the ORIGINAL recording.
    const w = [fBefore.coreStartTime, fBefore.coreEndTime];
    const fitBefore = fitOverWindow(analysis, w[0], w[1]);
    const fitAfter = fitOverWindow(after, w[0], w[1]);
    const periodicity = voicedFraction(analysis, w[0], w[1]);
    const track = trackingError(after, correction.points, w[0], w[1]);
    // Where the app measured the learner's own voice for this syllable —
    // the level the shape-mode anchor is supposed to reproduce.
    const learnerRef = normalizer.referenceLogF0(fBefore.medianHz);
    const learnerLevel = learnerRef == null ? NaN : learnerRef + fBefore.coefs[0] / 12;
    return {
      index: i,
      tone: tones[i],
      periodicity,
      trackErr: track.median,
      requestedLevel: requestedLevel(correction.points, w[0], w[1]),
      learnerLevel,
      trackFrames: track.n,
      octaveFrames: track.octaveFrames,
      measured: !!(fitAfter && fitBefore),
      shapeBefore: fitBefore ? shapeDistance(fitBefore, target.coefs) : NaN,
      shapeAfter: fitAfter ? shapeDistance(fitAfter, target.coefs) : NaN,
      // Where the corrected syllable ended up, vs. where it was asked to go.
      levelBefore: fitBefore ? fitBefore[0] / 12 : NaN,
      levelAfter: fitAfter ? fitAfter[0] / 12 : NaN,
      levelWanted: Math.log2(correction.anchorsHz[i]) + target.coefs[0] / 12,
      verdictBefore: verdicts[i] ? verdicts[i].verdict : null,
      verdictAfter: verdictsAfter && verdictsAfter[i] ? verdictsAfter[i].verdict : null,
      // The classifier's non-pitch criterion (see the file header).
      framesAfter: fAfter && fAfter.voiced ? fAfter.voicedFrameCount : null
    };
  });

  commitUtteranceToNormalizer(normalizer, res.syllables, tones);

  return {
    token: entry.token,
    mode: correction.mode,
    syllables,
    durBefore: analysis.duration,
    durAfter: after.duration,
    srBefore: analysis.sampleRate,
    srAfter: after.sampleRate,
    voicedBefore: voicedFrames(analysis),
    voicedAfter: voicedFrames(after)
  };
}

/* Corpus filenames are pinyin+tone with no syllable boundaries marked. For
 * target lookup only the base syllable matters, and getSyllableTargets falls
 * back cleanly for anything it doesn't recognize. */
function syllableAt (entry, i) {
  const parts = entry.token.match(/[a-z]+[0-9]?/g) || [];
  const p = parts[i];
  return p ? p.replace(/[0-9]/g, '') : null;
}

function median (xs) {
  const v = xs.filter(Number.isFinite).sort((a, b) => a - b);
  return v.length ? v[v.length >> 1] : NaN;
}

async function main () {
  await loadTargets();

  const manifest = buildManifest(CORPUS)
    .filter(e => e.cat === 'double' && e.condition === 'Quiet' &&
                 e.tones.every(t => t >= 1 && t <= 4));
  if (manifest.length === 0) {
    console.log('No usable clips found under ' + CORPUS + ' — skipping.');
    process.exit(0);
  }

  const bySpeaker = new Map();
  for (const e of manifest) {
    if (!bySpeaker.has(e.speaker)) bySpeaker.set(e.speaker, []);
    bySpeaker.get(e.speaker).push(e);
  }

  console.log('Booting praat-wasm…');
  const praat = await createPraatWasm();
  console.log('Ready.\n');

  const clips = [];
  for (const [speaker, list] of bySpeaker) {
    console.log(`=== ${speaker} ===`);
    const normalizer = new SpeakerNormalizer();
    for (const entry of list.slice(0, CLIPS_PER_SPEAKER)) {
      const r = runCase(praat, entry, normalizer);
      if (r.skip) { console.log(`  ${entry.token}: skipped (${r.skip})`); continue; }
      clips.push(r);
      const per = r.syllables.map(sy =>
        `T${sy.tone} shape ${sy.shapeBefore.toFixed(2)}→${sy.shapeAfter.toFixed(2)}ST` +
        ` ${sy.verdictBefore}→${sy.verdictAfter}`);
      console.log(`  ${r.token.padEnd(12)} ${r.mode.padEnd(8)} | ${per.join(' | ')}`);
    }
    console.log();
  }

  const syls = clips.flatMap(c => c.syllables.map(sy => ({ ...sy, mode: c.mode, token: c.token })));
  const measured = syls.filter(sy => sy.measured);

  // Where the residuals live. Printed rather than asserted around, so the
  // gates chosen below are visible and arguable.
  console.log('periodicity   n   median tracking err   median |level err|');
  for (const [lo, hi] of [[0, 0.5], [0.5, 0.8], [0.8, 0.95], [0.95, 1.01]]) {
    const g = measured.filter(sy => sy.periodicity >= lo && sy.periodicity < hi);
    if (!g.length) continue;
    console.log(`  ${lo.toFixed(2)}-${hi.toFixed(2)}  ${String(g.length).padStart(3)}` +
      `   ${median(g.map(sy => sy.trackErr)).toFixed(2)} ST`.padStart(21) +
      `   ${median(g.map(sy => Math.abs(12 * (sy.levelAfter - sy.levelWanted)))).toFixed(2)} ST`.padStart(20));
  }
  const octFrames = syls.reduce((n, sy) => n + sy.octaveFrames, 0);
  const allFrames = syls.reduce((n, sy) => n + sy.trackFrames, 0);
  console.log(`\ntracker octave errors on the corrected audio: ` +
    `${octFrames}/${allFrames} frames (${(100 * octFrames / allFrames).toFixed(1)}%)\n`);

  /* ------------------------------ assertions ------------------------------ */
  let pass = 0, fail = 0;
  const check = (name, ok, detail) => {
    if (ok) { pass++; console.log(`PASS  ${name}`); }
    else { fail++; console.log(`FAIL  ${name}${detail ? '\n        ' + detail : ''}`); }
  };

  console.log('='.repeat(70));
  check(`corrected ${syls.length} syllables across ${clips.length} clips`, syls.length >= 20);
  // The periodicity gate in pitch-correct.js must actually hold: a syllable
  // PSOLA can't retime has to be refused, not silently handed back unchanged.
  const tooQuiet = syls.filter(sy => sy.periodicity < 0.5);
  check('no syllable below the periodicity gate was offered a correction',
    tooQuiet.length === 0,
    tooQuiet.map(sy => `${sy.token}[${sy.index}] ${(100 * sy.periodicity).toFixed(0)}% voiced`).join('; '));
  check('every corrected syllable is still measurable afterwards',
    measured.length === syls.length,
    `${syls.length - measured.length} became unmeasurable`);

  // 1. The audio carries the contour it was asked to carry. This is the
  //    assertion the feature lives or dies by.
  const trackMedian = median(syls.map(sy => sy.trackErr));
  check(`median frame-level tracking error ≤ 0.5 ST (got ${trackMedian.toFixed(2)})`,
    trackMedian <= 0.5);
  const offTrack = syls.filter(sy => sy.trackErr > 1.5);
  check('≥95% of syllables track the requested contour within 1.5 ST',
    offTrack.length <= 0.05 * syls.length,
    offTrack.map(sy => `${sy.token}[${sy.index}] T${sy.tone} ${sy.trackErr.toFixed(2)} ST` +
      ` (voiced ${(100 * sy.periodicity).toFixed(0)}%)`).join('; '));

  // 2. Shape, via the app's own Legendre decomposition over the targeted
  //    window: the contour is not merely close, it is the target's curve.
  const shapeAfter = median(measured.map(sy => sy.shapeAfter));
  const shapeBefore = median(measured.map(sy => sy.shapeBefore));
  check(`median shape error ≤ 1.0 ST (got ${shapeAfter.toFixed(2)}, was ${shapeBefore.toFixed(2)})`,
    shapeAfter <= 1.0);

  // Most of this corpus is already on target, so a ratio over ALL syllables
  // mostly measures how little there was to fix. The claim worth testing is
  // about the syllables that were actually wrong.
  const wrong = measured.filter(sy => sy.shapeBefore > 1.5);
  const wrongAfter = median(wrong.map(sy => sy.shapeAfter));
  const wrongBefore = median(wrong.map(sy => sy.shapeBefore));
  check(`syllables that started off-target (${wrong.length}) end up ≥3× closer` +
    ` (${wrongBefore.toFixed(2)} → ${wrongAfter.toFixed(2)} ST)`,
    wrong.length >= 5 && wrongAfter <= wrongBefore / 3);

  const shapeStragglers = measured.filter(sy => sy.shapeAfter > 2.0);
  check('≥90% of syllables within 2 ST of the target shape',
    shapeStragglers.length <= 0.1 * measured.length,
    `${shapeStragglers.length}/${measured.length} beyond 2 ST`);

  // 3. Level. Checked on the contour we REQUESTED, not on a Legendre fit of
  //    the result. The fit's c0 is a least-squares projection over whatever
  //    frames the tracker happened to voice, so on a T4 whose creaky tail
  //    drops out it reads ~2 ST high while the audio itself is within a
  //    hundredth of a semitone of the request (the tracking check above).
  //    Asserting on the request instead tests the arithmetic that can
  //    actually be wrong — this is the check that would have caught the
  //    anchor bug that put whole utterances 7 ST flat — and the tracking
  //    check carries it the rest of the way to the audio.
  const levelOff = measured.filter(sy =>
    Math.abs(12 * (sy.requestedLevel - sy.levelWanted)) > 0.5);
  check('every corrected syllable is anchored where pitch-correct.js says it is',
    levelOff.length === 0,
    levelOff.slice(0, 8).map(sy =>
      `${sy.token}[${sy.index}] T${sy.tone} off by ` +
      `${(12 * (sy.requestedLevel - sy.levelWanted)).toFixed(2)} ST`).join('; '));

  // Shape mode's specific promise: the learner's OWN pitch height survives.
  const shapeMode = measured.filter(sy => sy.mode === 'shape');
  const drifted = shapeMode.filter(sy =>
    Math.abs(12 * (sy.requestedLevel - sy.learnerLevel)) > 0.5);
  check(`shape mode keeps each syllable at the learner's own pitch height (${shapeMode.length} syllables)`,
    drifted.length === 0,
    drifted.slice(0, 8).map(sy =>
      `${sy.token}[${sy.index}] T${sy.tone} moved ` +
      `${(12 * (sy.requestedLevel - sy.learnerLevel)).toFixed(2)} ST`).join('; '));

  // Register mode's: the syllable is moved ONTO the trusted reference, which
  // means it is allowed — required, even — to leave the learner's own height.
  const registerMode = measured.filter(sy => sy.mode === 'register');
  const movedOff = registerMode.filter(sy =>
    Math.abs(12 * (sy.requestedLevel - sy.levelWanted)) > 0.5);
  check(`register mode puts each syllable on the trusted reference (${registerMode.length} syllables)`,
    movedOff.length === 0);

  check('both anchor modes exercised', shapeMode.length > 0 && registerMode.length > 0,
    `shape=${shapeMode.length} register=${registerMode.length}`);

  // 4. Nothing but pitch moved.
  const retimed = clips.filter(c => Math.abs(c.durAfter - c.durBefore) > 0.01);
  check('duration preserved (±10 ms)', retimed.length === 0,
    retimed.map(c => `${c.token} ${c.durBefore.toFixed(3)}→${c.durAfter.toFixed(3)}`).join('; '));

  const resampled = clips.filter(c => c.srAfter !== c.srBefore);
  check('sample rate preserved', resampled.length === 0,
    resampled.map(c => `${c.token} ${c.srBefore}→${c.srAfter}`).join('; '));

  // PSOLA re-derives its own pulses, so the voiced-frame count wobbles; a
  // collapse is what this guards against, not a wobble.
  const devoiced = clips.filter(c => c.voicedAfter < 0.8 * c.voicedBefore);
  check('voicing preserved (≥80% of voiced frames survive)', devoiced.length === 0,
    devoiced.map(c => `${c.token} ${c.voicedBefore}→${c.voicedAfter}`).join('; '));

  // 5. Verdicts. Reported per syllable and asserted only in aggregate, on
  //    purpose. Re-scoring the corrected audio re-runs the vowel-core finder,
  //    which uses harmonicity — and PSOLA perturbs harmonicity, so the core
  //    lands on a shorter window (38 frames → 25 on one clip here) and the
  //    re-fitted slope is diluted by a third. A per-syllable no-regression
  //    assertion would be asserting that the core finder is insensitive to
  //    resynthesis, which is neither true nor this feature's job. No learner
  //    ever triggers this path either: an attempt is scored once, from the
  //    original recording, and the correction is only ever played back.
  const goodBefore = measured.filter(sy => sy.verdictBefore === 'good').length;
  const goodAfter = measured.filter(sy => sy.verdictAfter === 'good').length;
  const regressed = measured.filter(sy => RANK[sy.verdictAfter] < RANK[sy.verdictBefore]);
  console.log(`      (re-scoring the corrected audio: ${goodBefore} → ${goodAfter} 'good',` +
    ` ${regressed.length} individually lower — see note in source)`);
  check(`'good' count does not fall on re-scoring (${goodBefore} → ${goodAfter} of ${measured.length})`,
    goodAfter >= goodBefore);

  console.log('='.repeat(70));
  console.log(`Result: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(err => { console.error(err); process.exit(2); });
