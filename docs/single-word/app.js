/*
 * Tone Trainer — single-word controller.
 *
 * Boot order:
 *   1. Initialize Praat-WASM in a worker (pre-warm).
 *   2. Show practice card; user records target words, gets feedback.
 *
 * Boot runs an explicit calibration pass first: the learner says the four
 * tones of "ma" in order, each feeding the same SpeakerNormalizer instance
 * ordinary practice uses. The sequencing, the trust-gate check and the
 * one-extra-repeat rule all live in calibration.js (CalibrationSession),
 * shared verbatim with the phrase app in docs/multi-syllable/ so the two
 * can't drift; this file only draws the prompts and records. Skippable —
 * falls back to passive accumulation with the stricter default bar. Until
 * the reference is trusted, the classifier scores on shape only — slope,
 * curvature, duration, voice quality. Register cues (high vs low in the
 * speaker's range) start contributing once the reference stabilizes.
 *
 * Recording is push-and-hold via Pointer Events (one set of handlers
 * covers mouse, touch, and stylus).
 */

import {
  createRecorder, encodeWav, recordingFilename, downloadBlob
} from './audio.js';
import { ensureReady, analyzeWav, resynthesizeWithPitch } from './praat-engine.js';
import { ensureDenoiseReady, denoise } from './denoise.js';
import { extractFeatures, SpeakerNormalizer } from './features.js';
import { buildCorrectedPitchPointsForSyllable } from './pitch-correct.js';
import { classify } from './classifier.js';
import { renderSyllable, renderTargetOnly } from './viz.js';
import { buildReferences, matchSyllable } from './tone-match.js';
import { loadTargets } from './targets.js';
import { WORDS } from './words.js';
import { CalibrationSession, shouldCalibrate } from './calibration.js';

const VERDICT_TEXT = {
  good: { label: '✓ Nice!', cls: 'good' },
  close: { label: 'Almost', cls: 'close' },
  bad: { label: 'Try again', cls: 'bad' },
  uncertain: { label: 'Couldn\'t hear that', cls: 'uncertain' }
};

const UNCERTAIN_REASON_TEXT = {
  'no-voice': 'I didn\'t hear your voice clearly. Try again, a bit louder.',
  'too-short-voiced': 'Hold the sound a little longer, then let go.',
  'low-hnr': 'Try again — too much background noise or whisper.'
};

/* ------------------------------------------------------------------ */
/*  State                                                               */
/* ------------------------------------------------------------------ */

const state = {
  recorder: null,
  normalizer: new SpeakerNormalizer(),
  wordIdx: 0,
  lastWavBlob: null,
  correction: null,          // pitch points for the last attempt, or null
  correctedWavBlob: null,    // resynthesis result, built on first need
  correctionPromise: null,   // in-flight resynthesis, shared by play + download
  micMeterRaf: 0,
  ready: false,
  // CalibrationSession while a pass is running, else null. The sequencing
  // rules live in calibration.js, shared with the phrase app.
  calibration: null
};

/* ------------------------------------------------------------------ */
/*  DOM                                                                 */
/* ------------------------------------------------------------------ */

const $ = (id) => document.getElementById(id);
const els = {
  engineStatus: $('engine-status'),
  calibrationBanner: $('calibration-banner'),
  calibrationProgress: $('calibration-progress'),
  calibrationSkip: $('calibration-skip'),
  practice: $('practice'),
  prevWord: $('prev-word'),
  nextWord: $('next-word'),
  hanzi: $('word-hanzi'),
  pinyin: $('word-pinyin'),
  gloss: $('word-gloss'),
  canvas: $('contour-canvas'),
  recordBtn: $('record-btn'),
  playBtn: $('play-btn'),
  playFixedBtn: $('play-fixed-btn'),
  saveBtn: $('save-btn'),
  saveFixedBtn: $('save-fixed-btn'),
  micMeter: $('mic-meter').firstElementChild,
  feedback: $('feedback'),
  errorPanel: $('error-panel'),
  errorMessage: $('error-message')
};

/* ------------------------------------------------------------------ */
/*  Boot                                                                */
/* ------------------------------------------------------------------ */

async function boot () {
  try {
    setEngineStatus('loading', 'Loading analyzer…');
    // ensureDenoiseReady() never throws (denoising is an optional
    // enhancement — see denoise.js); a slow/failed CDN load for it must
    // never block the core app from becoming usable.
    await Promise.all([ensureReady(), loadTargets(), ensureDenoiseReady()]);
    setEngineStatus('ready', 'Ready');

    // Mic init is deferred to first interaction so the browser shows the
    // permission prompt in response to a user gesture (the press of the
    // record button).
    els.practice.classList.remove('hidden');
    els.recordBtn.disabled = false;

    bindPracticeHandlers();
    bindNavHandlers();
    bindCalibrationHandlers();
    // An already-calibrated normalizer (e.g. one restored from another app)
    // shouldn't be put through the pass again.
    if (shouldCalibrate(state.normalizer)) startCalibration();
    else refreshWord();
  } catch (err) {
    console.error(err);
    showError(err.message || String(err));
    setEngineStatus('error', 'Failed');
  }
}

function setEngineStatus (cls, text) {
  els.engineStatus.className = 'engine-status ' + cls;
  els.engineStatus.textContent = text;
}

function showError (msg) {
  els.errorPanel.classList.remove('hidden');
  els.errorMessage.textContent = msg;
}

/* ------------------------------------------------------------------ */
/*  Microphone (lazy)                                                   */
/* ------------------------------------------------------------------ */

async function ensureRecorder () {
  if (state.recorder) return state.recorder;
  try {
    state.recorder = await createRecorder();
    return state.recorder;
  } catch (err) {
    showError('Microphone access was denied or unavailable: ' + (err.message || err));
    throw err;
  }
}

function startMicMeter () {
  cancelAnimationFrame(state.micMeterRaf);
  const tick = () => {
    if (!state.recorder || !state.recorder.isRecording) {
      els.micMeter.style.width = '0%';
      return;
    }
    const lvl = state.recorder.getMicLevel();
    els.micMeter.style.width = Math.round(lvl * 100) + '%';
    state.micMeterRaf = requestAnimationFrame(tick);
  };
  state.micMeterRaf = requestAnimationFrame(tick);
}

/* ------------------------------------------------------------------ */
/*  Push-and-hold binding                                               */
/* ------------------------------------------------------------------ */

function bindHold (button, onStart, onStop) {
  // Track whether *this* gesture is actively recording so we don't fire
  // onStop twice (e.g., pointerup + pointerleave).
  let active = false;

  const start = async (e) => {
    if (button.disabled || active) return;
    e.preventDefault();
    active = true;
    button.classList.add('recording');
    button.setPointerCapture?.(e.pointerId);
    try { await onStart(); }
    catch (err) {
      active = false;
      button.classList.remove('recording');
      throw err;
    }
  };

  const stop = async (e) => {
    if (!active) return;
    active = false;
    button.classList.remove('recording');
    if (e && e.pointerId != null) button.releasePointerCapture?.(e.pointerId);
    try { await onStop(); }
    catch (err) { console.error(err); }
  };

  button.addEventListener('pointerdown', start);
  button.addEventListener('pointerup', stop);
  button.addEventListener('pointercancel', stop);
  button.addEventListener('pointerleave', stop);
}

/**
 * Window-level Space-to-record. Acts on the supplied button regardless
 * of focus, but only when it's enabled and visible. Skips if the user
 * is typing in a form field.
 */
function bindSpacebarHold (button, onStart, onStop) {
  let active = false;

  const isEditableTarget = () => {
    const a = document.activeElement;
    if (!a) return false;
    const tag = a.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || a.isContentEditable;
  };

  window.addEventListener('keydown', async (e) => {
    if (e.code !== 'Space' || e.repeat || active) return;
    if (button.disabled || isEditableTarget()) return;
    if (button.offsetParent === null) return;   // hidden / not laid out
    e.preventDefault();
    active = true;
    button.classList.add('recording');
    try { await onStart(); }
    catch (err) {
      active = false;
      button.classList.remove('recording');
      console.error(err);
    }
  });

  window.addEventListener('keyup', async (e) => {
    if (e.code !== 'Space' || !active) return;
    e.preventDefault();
    active = false;
    button.classList.remove('recording');
    try { await onStop(); }
    catch (err) { console.error(err); }
  });
}

/* ------------------------------------------------------------------ */
/*  Practice                                                            */
/* ------------------------------------------------------------------ */

function bindPracticeHandlers () {
  const onRecordStart = async () => {
    const rec = await ensureRecorder();
    rec.start();
    startMicMeter();
    els.feedback.innerHTML = '';
    enableRawPlayback(false);
    clearCorrection();
  };

  const onRecordStop = async () => {
      if (!state.recorder) return;
      const { wav, durationSec, samples, sampleRate } = await state.recorder.stop();
      if (!wav || durationSec < 0.15) {
        els.feedback.innerHTML =
          '<span class="badge uncertain">Couldn\'t hear that</span>' +
          '<div class="diagnostic">Hold the button while you say the word.</div>';
        return;
      }

      // Snapshot for playback BEFORE analysis: analyzeWav transfers the
      // ArrayBuffer to the Praat worker, which detaches it on this thread
      // — a Blob built afterwards would be empty. Playback always uses
      // this original, un-denoised capture; only the copy sent for
      // analysis below is denoised (see denoise.js) — measured to help
      // noisy recordings without regressing clean ones, but it's an
      // enhancement to scoring, not to what the learner hears back.
      state.lastWavBlob = new Blob([wav], { type: 'audio/wav' });
      enableRawPlayback(true);

      els.feedback.innerHTML = '<span class="diagnostic">Listening…</span>';

      try {
        let analysisWav = wav;
        try {
          const denoised = await denoise(samples, sampleRate);
          analysisWav = encodeWav(denoised, sampleRate);
        } catch (err) {
          console.warn('Denoising unavailable, scoring original audio:', err);
        }

        const analysis = await analyzeWav(analysisWav);
        const features = extractFeatures(analysis, state.normalizer);
        const word = currentWord();
        const refs = buildReferences(word.tone);

        // One match drives the mark, the band and the corrected playback, so
        // none of the three can describe a different comparison than the others.
        const match = features.voiced ? matchSyllable(features, refs) : null;
        // Before an attempt the canvas shows the dominant realization; here it
        // swaps to the one the learner actually matched.
        const target = (match && match.ref) || refs[0] || null;

        renderSyllable(els.canvas, { ref: target, match, features });

        if (!features.voiced) {
          els.feedback.innerHTML =
            '<span class="badge uncertain">' + VERDICT_TEXT.uncertain.label + '</span>' +
            '<div class="diagnostic">' +
            (UNCERTAIN_REASON_TEXT[features.reason] || 'Try again.') +
            '</div>';
          return;
        }

        // Corrected-playback contour, built BEFORE the normalizer is updated
        // below so it is anchored on the register this attempt was scored
        // against — the same ordering, and the same reason, as the phrase
        // trainer's. Only the pitch points are computed here; the resynthesis
        // waits for a click (see playCorrected), so an attempt nobody asks to
        // hear costs nothing. Not offered during calibration: those prompts
        // aren't graded, so there is no verdict for a correction to belong to.
        if (!isCalibrating()) {
          state.correction = buildCorrectedPitchPointsForSyllable(
            analysis, features, target, state.normalizer);
          state.correctedWavBlob = null;
          state.correctionPromise = null;
          enableCorrectedPlayback(!!state.correction && !!state.lastWavBlob);
          els.playFixedBtn.textContent = 'Play your corrected voice';
        }

        // Update the running speaker reference with the filtered
        // subset of voiced frames (steady-state, loud, no octave errors).
        // The target tone feeds the trust gate's tone-diversity check.
        state.normalizer.add(features.referenceFrames, word.tone);

        if (isCalibrating()) {
          advanceCalibration();
          return;
        }

        // Geometry decides good/close/bad because geometry is what was drawn;
        // classify() still supplies the coaching sentence and its own opinion of
        // which tone it heard.
        const cls = classify(word.tone, features);
        showVerdict({ ...cls, verdict: match ? match.verdict : 'uncertain' }, word.tone, match);
      } catch (err) {
        console.error(err);
        els.feedback.innerHTML =
          '<span class="badge uncertain">Couldn\'t analyze that</span>' +
          '<div class="diagnostic">' + (err.message || 'Try again.') + '</div>';
      }
  };

  bindHold(els.recordBtn, onRecordStart, onRecordStop);
  bindSpacebarHold(els.recordBtn, onRecordStart, onRecordStop);

  els.playBtn.addEventListener('click', () => play(state.lastWavBlob));
  els.playFixedBtn.addEventListener('click', playCorrected);
  els.saveBtn.addEventListener('click', downloadRecording);
  els.saveFixedBtn.addEventListener('click', downloadCorrected);
}

/*
 * Play and download are enabled and disabled together, through these two
 * helpers rather than at each call site. There is no state in which one
 * makes sense without the other, and the failure mode of letting them drift
 * is a download button handing over the PREVIOUS attempt's audio under this
 * attempt's filename — silently wrong data, in a feature whose whole point
 * is to produce files someone will later analyse.
 */
function enableRawPlayback (on) {
  els.playBtn.disabled = !on;
  els.saveBtn.disabled = !on;
}

function enableCorrectedPlayback (on) {
  els.playFixedBtn.disabled = !on;
  els.saveFixedBtn.disabled = !on;
}

/** Download the recording exactly as captured. */
function downloadRecording () {
  if (!state.lastWavBlob) return;
  downloadBlob(state.lastWavBlob, recordingFilename(promptSyllables(), 'orig'));
}

/**
 * Download the pitch-corrected recording, synthesizing it on the spot if the
 * learner never pressed play — downloading and listening are independent
 * things to want, and making one a precondition of the other would be an
 * artifact of how this is cached, not a real constraint.
 */
async function downloadCorrected () {
  const blob = await ensureCorrectedWav();
  if (blob) downloadBlob(blob, recordingFilename(promptSyllables(), 'corrected'));
}

/** The current prompt as {base, tone}, for naming a download. */
function promptSyllables () {
  const w = currentWord();
  return w ? [{ base: w.syllable, tone: w.tone }] : [];
}

/** Shared one-shot playback; revokes the object URL when it finishes. */
function play (blob) {
  if (!blob) return;
  const url = URL.createObjectURL(blob);
  const audio = new Audio(url);
  audio.addEventListener('ended', () => URL.revokeObjectURL(url));
  audio.play().catch(err => {
    URL.revokeObjectURL(url);
    console.error('Playback failed:', err);
  });
}

/*
 * Play the learner's own recording with the tone corrected: same voice,
 * same timing, same word, F0 replaced by the target contour drawn on the
 * canvas (docs/single-word/pitch-correct.js has the rules for what is and
 * isn't corrected).
 */
async function playCorrected () {
  const blob = await ensureCorrectedWav();
  if (blob) play(blob);
}

/*
 * The corrected WAV, resynthesized on first need and cached thereafter.
 *
 * The in-flight promise is cached too, not just the result: play and
 * download are two buttons onto the same audio, and a learner who hits both
 * before the first finishes would otherwise run the Praat pass twice and
 * race over which result gets stored.
 */
function ensureCorrectedWav () {
  if (state.correctedWavBlob) return Promise.resolve(state.correctedWavBlob);
  if (state.correctionPromise) return state.correctionPromise;
  if (!state.correction || !state.lastWavBlob) return Promise.resolve(null);

  const btn = els.playFixedBtn;
  enableCorrectedPlayback(false);
  btn.textContent = 'Correcting…';

  state.correctionPromise = (async () => {
    try {
      // resynthesizeWithPitch TRANSFERS its buffer to the worker, so this has
      // to be a fresh copy from the Blob — the original capture buffer was
      // already detached by the analysis pass.
      const source = await state.lastWavBlob.arrayBuffer();
      const wav = await resynthesizeWithPitch(source, state.correction.points);
      state.correctedWavBlob = new Blob([wav], { type: 'audio/wav' });
      btn.textContent = 'Play your corrected voice';
      enableCorrectedPlayback(true);
      return state.correctedWavBlob;
    } catch (err) {
      console.error('Pitch correction failed:', err);
      // Say so rather than leaving controls that silently do nothing; the
      // next attempt re-enables them.
      btn.textContent = 'Correction unavailable';
      return null;
    } finally {
      state.correctionPromise = null;
    }
  })();
  return state.correctionPromise;
}

/** Drop any corrected audio and the points it would be built from. */
function clearCorrection () {
  state.correction = null;
  state.correctedWavBlob = null;
  state.correctionPromise = null;
  enableCorrectedPlayback(false);
  els.playFixedBtn.textContent = 'Play your corrected voice';
}

function showVerdict (v, targetTone, match) {
  const meta = VERDICT_TEXT[v.verdict] || VERDICT_TEXT.uncertain;
  let html = `<span class="badge ${meta.cls}">${meta.label}</span>`;
  if (v.verdict !== 'good' && v.diagnostic) {
    html += `<div class="diagnostic">${escapeHtml(v.diagnostic)}</div>`;
  }
  // Duration is reported, never scored — see tone-match.js. Saying it out loud
  // is what keeps it from being the invisible reason a good-looking contour
  // came back wrong, which is what the old duration gate was.
  if (match && match.durationOk === false) {
    html += `<div class="diagnostic">${match.durationRatio > 1
      ? 'That was a bit long — try saying it more briskly.'
      : 'That was very short — give the tone room to move.'}</div>`;
  }
  if (v.bestTone && v.bestTone !== targetTone &&
      v.scores[v.bestTone - 1] > v.targetScore + 0.1) {
    html += `<div class="detected">I heard tone ${v.bestTone}.</div>`;
  }
  els.feedback.innerHTML = html;
}

function escapeHtml (s) {
  return s.replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

/* ------------------------------------------------------------------ */
/*  Word navigation                                                     */
/* ------------------------------------------------------------------ */

function bindNavHandlers () {
  els.prevWord.addEventListener('click', () => {
    state.wordIdx = (state.wordIdx - 1 + WORDS.length) % WORDS.length;
    refreshWord();
  });
  els.nextWord.addEventListener('click', () => {
    state.wordIdx = (state.wordIdx + 1) % WORDS.length;
    refreshWord();
  });
}

/**
 * The word on screen: a calibration prompt while a pass is running,
 * otherwise the practice word the learner navigated to.
 */
function currentWord () {
  return isCalibrating() ? state.calibration.item : WORDS[state.wordIdx];
}

function isCalibrating () {
  return !!(state.calibration && state.calibration.active);
}

function refreshWord () {
  const w = currentWord();
  els.hanzi.textContent = w.hanzi;
  els.pinyin.textContent = w.pinyin;
  els.pinyin.className = 'pinyin t' + w.tone;
  els.gloss.textContent = w.gloss;
  els.feedback.innerHTML = '';
  enableRawPlayback(false);
  state.lastWavBlob = null;
  clearCorrection();
  renderTargetOnly(els.canvas, currentTarget(w));
}

/**
 * The reference to aim at before an attempt: the tone's dominant realization.
 * References come sorted most-common-first from tone-match.js, and they carry
 * their own register height, so there is nothing to look up per syllable.
 */
function currentTarget (word) {
  return buildReferences(word.tone)[0] || null;
}

/* ------------------------------------------------------------------ */
/*  Calibration                                                         */
/* ------------------------------------------------------------------ */

function bindCalibrationHandlers () {
  els.calibrationSkip.addEventListener('click', () => {
    // session.skip() deliberately does NOT markCalibrated(): this falls back
    // to passive accumulation with the stricter default bar.
    if (state.calibration) state.calibration.skip();
    exitCalibrationUI();
  });
}

function startCalibration () {
  state.calibration = new CalibrationSession(state.normalizer);
  if (!state.calibration.active) { exitCalibrationUI(); return; }
  els.calibrationBanner.classList.remove('hidden');
  els.prevWord.disabled = true;
  els.nextWord.disabled = true;
  showCalibrationPrompt();
}

function showCalibrationPrompt () {
  refreshWord();
  els.calibrationProgress.textContent = state.calibration.progressLabel;
}

function advanceCalibration () {
  const stillCalibrating = state.calibration.accept();
  if (stillCalibrating) {
    showCalibrationPrompt();
  } else {
    exitCalibrationUI();
  }
  // Written AFTER the refresh above, not before: refreshWord() clears
  // #feedback, so a badge set first was wiped in the same task and could
  // never actually be seen.
  els.feedback.innerHTML = stillCalibrating
    ? '<span class="badge good">\u2713 Got it</span>'
    : '<span class="badge good">\u2713 Pitch range set</span>';
}

function exitCalibrationUI () {
  els.calibrationBanner.classList.add('hidden');
  els.prevWord.disabled = false;
  els.nextWord.disabled = false;
  state.wordIdx = 0;
  refreshWord();
}

window.addEventListener('DOMContentLoaded', boot);
