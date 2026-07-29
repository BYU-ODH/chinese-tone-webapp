/*
 * Stage 2 Track A harness — live-browser paired A/B of mic constraints
 * (echoCancellation/noiseSuppression/autoGainControl) against the
 * production app's default (all off, undocumented — see
 * DISCUSSION_REMINDERS.md and audio.js's header).
 *
 * Can't be automated in Node (a real browser + real mic is needed). The
 * two constraint settings are captured from a SINGLE recording gesture,
 * not two separate takes: two concurrent getUserMedia streams (one per
 * arm) are opened up front, each with its own already-running
 * AudioWorklet capture graph (see audio.js — start()/stop() just toggle a
 * flag on a graph that's already live), so calling both recorders'
 * start() back-to-back and both stop() via Promise.all gives sub-
 * millisecond-aligned capture of the SAME spoken utterance through both
 * DSP configurations. Recording it twice instead would confound the
 * comparison with ordinary utterance-to-utterance variation (timing,
 * loudness, pitch) — exactly the mistake this design avoids.
 *
 * Both takes run through the EXACT same unmodified pipeline app.js uses
 * (denoise → analyzeWav → extractFeatures → classify). Each arm (OFF/ON)
 * gets its OWN SpeakerNormalizer, mirroring how a real deployment would
 * only ever run with ONE fixed constraint setting — never a shared,
 * cross-contaminated reference.
 *
 * Usage: run a batch of words tagged "Quiet", then a batch tagged "Noisy"
 * (deliberate background noise), then compare gate-failure rate,
 * coefficient deltas, and verdicts between OFF and ON via the running
 * summary below, or export the raw JSON for offline analysis.
 */
import { createRecorder, encodeWav } from './audio.js';
import { ensureReady, analyzeWav } from './praat-engine.js';
import { ensureDenoiseReady, denoise } from './denoise.js';
import { extractFeatures, SpeakerNormalizer } from './features.js';
import { classify } from './classifier.js';
import { WORDS } from './words.js';

const ARMS = ['off', 'on'];

const $ = (id) => document.getElementById(id);
const els = {
  engineStatus: $('engine-status'),
  conditionSelect: $('condition-select'),
  trial: $('trial'),
  prevWord: $('prev-word'),
  nextWord: $('next-word'),
  hanzi: $('word-hanzi'),
  pinyin: $('word-pinyin'),
  gloss: $('word-gloss'),
  recordBoth: $('record-both'),
  micMeterBoth: $('mic-meter-both').firstElementChild,
  playOff: $('play-off'),
  playOn: $('play-on'),
  resultOff: $('result-off'),
  resultOn: $('result-on'),
  commitTrial: $('commit-trial'),
  summary: $('summary'),
  summaryBody: $('summary-body'),
  trialsBody: $('trials-body'),
  copyJson: $('copy-json'),
  downloadJson: $('download-json'),
  errorPanel: $('error-panel'),
  errorMessage: $('error-message')
};

const playBtnFor = { off: els.playOff, on: els.playOn };
const resultElFor = { off: els.resultOff, on: els.resultOn };

const state = {
  wordIdx: 0,
  recorders: { off: null, on: null },
  normalizers: { off: new SpeakerNormalizer(), on: new SpeakerNormalizer() },
  takes: { off: null, on: null }, // { blob, samples, sampleRate, features, verdict }
  trials: [] // committed rows
};

async function boot () {
  try {
    setEngineStatus('loading', 'Loading analyzer…');
    await Promise.all([ensureReady(), ensureDenoiseReady()]);
    setEngineStatus('ready', 'Ready');
    els.trial.classList.remove('hidden');
    els.recordBoth.disabled = false;
    bindHandlers();
    refreshWord();
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
/*  Mic — both arms' streams opened together so a single recording     */
/*  gesture drives both simultaneously (see header).                   */
/* ------------------------------------------------------------------ */

async function ensureRecorders () {
  if (state.recorders.off && state.recorders.on) return state.recorders;
  try {
    const [off, on] = await Promise.all([
      createRecorder(), // defaults: all constraints false, matching today's production app.js
      createRecorder({ echoCancellation: true, noiseSuppression: true, autoGainControl: true })
    ]);
    state.recorders.off = off;
    state.recorders.on = on;
    return state.recorders;
  } catch (err) {
    showError('Microphone access was denied or unavailable: ' + (err.message || err));
    throw err;
  }
}

function startMicMeter () {
  const raf = () => {
    const rec = state.recorders.off;
    if (!rec || !rec.isRecording) { els.micMeterBoth.style.width = '0%'; return; }
    els.micMeterBoth.style.width = Math.round(rec.getMicLevel() * 100) + '%';
    requestAnimationFrame(raf);
  };
  requestAnimationFrame(raf);
}

/* ------------------------------------------------------------------ */
/*  Recording + scoring (mirrors app.js's onRecordStop pipeline)       */
/* ------------------------------------------------------------------ */

function bindHold (button, onStart, onStop) {
  let active = false;
  const start = async (e) => {
    if (button.disabled || active) return;
    e.preventDefault();
    active = true;
    button.classList.add('recording');
    button.setPointerCapture?.(e.pointerId);
    try { await onStart(); } catch (err) { active = false; button.classList.remove('recording'); throw err; }
  };
  const stop = async (e) => {
    if (!active) return;
    active = false;
    button.classList.remove('recording');
    if (e && e.pointerId != null) button.releasePointerCapture?.(e.pointerId);
    try { await onStop(); } catch (err) { console.error(err); }
  };
  button.addEventListener('pointerdown', start);
  button.addEventListener('pointerup', stop);
  button.addEventListener('pointercancel', stop);
  button.addEventListener('pointerleave', stop);
}

async function startBothRecording () {
  const { off, on } = await ensureRecorders();
  for (const arm of ARMS) {
    resultElFor[arm].className = 'ab-result';
    resultElFor[arm].textContent = '';
    playBtnFor[arm].disabled = true;
  }
  // Back-to-back synchronous calls onto already-running capture graphs —
  // this is what gives the two arms sub-millisecond-aligned capture of
  // the SAME utterance rather than two separate takes.
  off.start();
  on.start();
  startMicMeter();
}

async function stopBothRecording () {
  const { off, on } = state.recorders;
  // Guards the same race app.js's onRecordStop guards against: the button
  // can be released before ensureRecorders() (two concurrent getUserMedia
  // + AudioWorklet setups, first recording only) has resolved.
  if (!off || !on) return;
  const [offRaw, onRaw] = await Promise.all([off.stop(), on.stop()]);
  await Promise.all([
    scoreTake('off', offRaw),
    scoreTake('on', onRaw)
  ]);
  checkCommitReady();
}

async function scoreTake (arm, raw) {
  const resultEl = resultElFor[arm];
  const playBtn = playBtnFor[arm];
  const { wav, durationSec, samples, sampleRate } = raw;
  if (!wav || durationSec < 0.15) {
    resultEl.className = 'ab-result gate-fail';
    resultEl.textContent = 'Too short / not captured — try again.';
    state.takes[arm] = null;
    return;
  }
  state.takes[arm] = { blob: new Blob([wav], { type: 'audio/wav' }), samples, sampleRate };
  playBtn.disabled = false;
  resultEl.textContent = 'Analyzing…';

  try {
    let analysisWav = wav;
    try {
      const denoised = await denoise(samples, sampleRate);
      analysisWav = encodeWav(denoised, sampleRate);
    } catch (err) {
      console.warn('Denoising unavailable, scoring original audio:', err);
    }
    const analysis = await analyzeWav(analysisWav);
    const features = extractFeatures(analysis, state.normalizers[arm]);
    const word = WORDS[state.wordIdx];

    if (!features.voiced) {
      state.takes[arm].features = features;
      state.takes[arm].verdict = null;
      renderResult(resultEl, features, null);
      return;
    }

    state.normalizers[arm].add(features.referenceFrames, word.tone);
    const verdict = classify(word.tone, features);
    state.takes[arm].features = features;
    state.takes[arm].verdict = verdict;
    renderResult(resultEl, features, verdict);
  } catch (err) {
    console.error(err);
    resultEl.className = 'ab-result gate-fail';
    resultEl.textContent = 'Analysis error: ' + (err.message || err);
  }
}

function renderResult (el, features, verdict) {
  if (!features.voiced) {
    el.className = 'ab-result gate-fail';
    el.textContent = `GATE FAIL: ${features.reason}\nduration=${features.duration?.toFixed(2)}s hnrMean=${features.hnrMean?.toFixed(1)}`;
    return;
  }
  const coefs = features.coefs.map(c => c.toFixed(2)).join(', ');
  el.className = 'ab-result verdict-' + verdict.verdict;
  el.textContent =
    `voiced OK (${features.voicedFrameCount}f, ${features.voicedDuration.toFixed(2)}s, hnr=${features.hnrMean.toFixed(1)})\n` +
    `coefs=[${coefs}]\n` +
    `verdict=${verdict.verdict} targetScore=${verdict.targetScore.toFixed(2)} bestTone=${verdict.bestTone}`;
}

function checkCommitReady () {
  els.commitTrial.disabled = !(state.takes.off?.features && state.takes.on?.features);
}

/* ------------------------------------------------------------------ */
/*  Word navigation + trial commit                                     */
/* ------------------------------------------------------------------ */

function refreshWord () {
  const w = WORDS[state.wordIdx];
  els.hanzi.textContent = w.hanzi;
  els.pinyin.textContent = w.pinyin;
  els.pinyin.className = 'pinyin t' + w.tone;
  els.gloss.textContent = w.gloss;
  state.takes = { off: null, on: null };
  els.resultOff.className = 'ab-result';
  els.resultOff.textContent = '';
  els.resultOn.className = 'ab-result';
  els.resultOn.textContent = '';
  els.playOff.disabled = true;
  els.playOn.disabled = true;
  els.commitTrial.disabled = true;
}

function playBlob (blob) {
  if (!blob) return;
  const url = URL.createObjectURL(blob);
  const audio = new Audio(url);
  audio.addEventListener('ended', () => URL.revokeObjectURL(url));
  audio.play().catch(err => { URL.revokeObjectURL(url); console.error('Playback failed:', err); });
}

function summarizeTake (take) {
  if (!take || !take.features) return null;
  if (!take.features.voiced) return { voiced: false, reason: take.features.reason };
  return {
    voiced: true,
    coefs: take.features.coefs,
    hnrMean: take.features.hnrMean,
    voicedDuration: take.features.voicedDuration,
    verdict: take.verdict.verdict,
    targetScore: take.verdict.targetScore,
    bestTone: take.verdict.bestTone
  };
}

function commitTrial () {
  const word = WORDS[state.wordIdx];
  const row = {
    n: state.trials.length + 1,
    condition: els.conditionSelect.value,
    word: word.pinyin,
    tone: word.tone,
    off: summarizeTake(state.takes.off),
    on: summarizeTake(state.takes.on)
  };
  state.trials.push(row);
  renderTrialRow(row);
  renderSummary();
  state.wordIdx = (state.wordIdx + 1) % WORDS.length;
  refreshWord();
}

function fmtCoefs (t) {
  if (!t) return '';
  if (!t.voiced) return '—';
  return t.coefs.map(c => c.toFixed(1)).join(', ');
}

function renderTrialRow (row) {
  els.summary.classList.remove('hidden');
  const tr = document.createElement('tr');
  const cell = (v) => { const td = document.createElement('td'); td.textContent = v; return td; };
  tr.appendChild(cell(row.n));
  tr.appendChild(cell(row.condition));
  tr.appendChild(cell(row.word));
  tr.appendChild(cell(row.off?.voiced ? 'pass' : `FAIL: ${row.off?.reason}`));
  tr.appendChild(cell(row.off?.voiced ? row.off.verdict : '—'));
  tr.appendChild(cell(fmtCoefs(row.off)));
  tr.appendChild(cell(row.on?.voiced ? 'pass' : `FAIL: ${row.on?.reason}`));
  tr.appendChild(cell(row.on?.voiced ? row.on.verdict : '—'));
  tr.appendChild(cell(fmtCoefs(row.on)));
  els.trialsBody.appendChild(tr);
}

function renderSummary () {
  const byCondition = {};
  for (const row of state.trials) {
    const c = row.condition;
    byCondition[c] ??= { n: 0, offPass: 0, onPass: 0, offGood: 0, onGood: 0 };
    const b = byCondition[c];
    b.n++;
    if (row.off?.voiced) b.offPass++;
    if (row.on?.voiced) b.onPass++;
    if (row.off?.verdict === 'good') b.offGood++;
    if (row.on?.verdict === 'good') b.onGood++;
  }
  let html = '<table><tr><th>Condition</th><th>n</th><th>OFF gate-pass</th><th>ON gate-pass</th><th>OFF "good"</th><th>ON "good"</th></tr>';
  for (const [cond, b] of Object.entries(byCondition)) {
    html += `<tr><td>${cond}</td><td>${b.n}</td>` +
      `<td>${b.offPass}/${b.n} (${(100 * b.offPass / b.n).toFixed(0)}%)</td>` +
      `<td>${b.onPass}/${b.n} (${(100 * b.onPass / b.n).toFixed(0)}%)</td>` +
      `<td>${b.offGood}/${b.n} (${(100 * b.offGood / b.n).toFixed(0)}%)</td>` +
      `<td>${b.onGood}/${b.n} (${(100 * b.onGood / b.n).toFixed(0)}%)</td></tr>`;
  }
  html += '</table>';
  els.summaryBody.innerHTML = html;
}

/* ------------------------------------------------------------------ */
/*  Export                                                             */
/* ------------------------------------------------------------------ */

function resultsJson () {
  return JSON.stringify({ trials: state.trials }, null, 2);
}

/* ------------------------------------------------------------------ */
/*  Wiring                                                             */
/* ------------------------------------------------------------------ */

function bindHandlers () {
  bindHold(els.recordBoth, startBothRecording, stopBothRecording);

  els.prevWord.addEventListener('click', () => {
    state.wordIdx = (state.wordIdx - 1 + WORDS.length) % WORDS.length;
    refreshWord();
  });
  els.nextWord.addEventListener('click', () => {
    state.wordIdx = (state.wordIdx + 1) % WORDS.length;
    refreshWord();
  });

  els.playOff.addEventListener('click', () => playBlob(state.takes.off?.blob));
  els.playOn.addEventListener('click', () => playBlob(state.takes.on?.blob));

  els.commitTrial.addEventListener('click', commitTrial);

  els.copyJson.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(resultsJson());
      els.copyJson.textContent = 'Copied!';
      setTimeout(() => { els.copyJson.textContent = 'Copy results as JSON'; }, 1500);
    } catch (err) {
      console.error('Clipboard write failed:', err);
    }
  });

  els.downloadJson.addEventListener('click', () => {
    const blob = new Blob([resultsJson()], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `mic-ab-results-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  });
}

window.addEventListener('DOMContentLoaded', boot);
