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

import { createRecorder, encodeWav } from './audio.js';
import { ensureReady, analyzeWav } from './praat-engine.js';
import { ensureDenoiseReady, denoise } from './denoise.js';
import { extractFeatures, SpeakerNormalizer } from './features.js';
import { classify } from './classifier.js';
import { render, renderTargetOnly } from './viz.js';
import { loadTargets, getSyllableTargets } from './targets.js';
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
    els.playBtn.disabled = true;
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
      els.playBtn.disabled = false;

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
        const target = currentTarget(word);

        render(els.canvas, target, features);

        if (!features.voiced) {
          els.feedback.innerHTML =
            '<span class="badge uncertain">' + VERDICT_TEXT.uncertain.label + '</span>' +
            '<div class="diagnostic">' +
            (UNCERTAIN_REASON_TEXT[features.reason] || 'Try again.') +
            '</div>';
          return;
        }

        // Update the running speaker reference with the filtered
        // subset of voiced frames (steady-state, loud, no octave errors).
        // The target tone feeds the trust gate's tone-diversity check.
        state.normalizer.add(features.referenceFrames, word.tone);

        if (isCalibrating()) {
          advanceCalibration();
          return;
        }

        const verdict = classify(word.tone, features);
        showVerdict(verdict, word.tone);
      } catch (err) {
        console.error(err);
        els.feedback.innerHTML =
          '<span class="badge uncertain">Couldn\'t analyze that</span>' +
          '<div class="diagnostic">' + (err.message || 'Try again.') + '</div>';
      }
  };

  bindHold(els.recordBtn, onRecordStart, onRecordStop);
  bindSpacebarHold(els.recordBtn, onRecordStart, onRecordStop);

  els.playBtn.addEventListener('click', () => {
    if (!state.lastWavBlob) return;
    const url = URL.createObjectURL(state.lastWavBlob);
    const audio = new Audio(url);
    audio.addEventListener('ended', () => URL.revokeObjectURL(url));
    audio.play().catch(err => {
      URL.revokeObjectURL(url);
      console.error('Playback failed:', err);
    });
  });
}

function showVerdict (v, targetTone) {
  const meta = VERDICT_TEXT[v.verdict] || VERDICT_TEXT.uncertain;
  let html = `<span class="badge ${meta.cls}">${meta.label}</span>`;
  if (v.diagnostic) {
    html += `<div class="diagnostic">${escapeHtml(v.diagnostic)}</div>`;
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
  els.playBtn.disabled = true;
  state.lastWavBlob = null;
  renderTargetOnly(els.canvas, currentTarget(w));
}

/** Resolve {tone, coefs} for a WORDS entry from the targets corpus. */
function currentTarget (word) {
  const all = getSyllableTargets(word.syllable);
  const entry = all[word.tone];
  return { tone: word.tone, coefs: entry.coefs, source: entry.source };
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
