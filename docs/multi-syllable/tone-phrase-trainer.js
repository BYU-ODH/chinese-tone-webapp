/*
 * <tone-phrase-trainer> — per-syllable tone feedback for a multi-syllable
 * phrase, packaged as a custom element so it can be embedded in a larger
 * app (e.g. the planned learning-outcomes experiment) rather than only run
 * as a standalone page. index.html in this directory is a thin demo host;
 * it contains no logic the component doesn't already own.
 *
 * ---------------------------------------------------------------------
 * USAGE
 *
 *   import './tone-phrase-trainer.js';           // registers the element
 *
 *   <tone-phrase-trainer></tone-phrase-trainer>
 *
 * Embedded in a host that drives its own trial order and logs results:
 *
 *   const el = document.createElement('tone-phrase-trainer');
 *   el.setAttribute('hide-nav', '');             // host controls progression
 *   el.phrases = myTrialList;                    // any PHRASES-shaped array
 *   el.addEventListener('attempt', e => log(e.detail));
 *   container.append(el);                        // loads the engine on connect
 *   await el.load();                             // or await readiness explicitly
 *   el.phraseIndex = 3;                          // jump to a specific trial
 *
 * ATTRIBUTES
 *   phrase-index    initial/current phrase index (reflected both ways)
 *   hide-nav        hide the built-in prev/next buttons
 *   hide-playback   hide the "play your voice" button
 *   defer           do NOT load the analysis engine on connect; the host
 *                   calls load() when it wants the (~30MB WASM) download
 *   skip-calibration  do not run the calibration pass on load (the host
 *                   either calibrated elsewhere and injected a normalizer,
 *                   or accepts shape-only scoring)
 *
 * PROPERTIES
 *   phrases       get/set the curriculum array (defaults to PHRASES)
 *   phraseIndex   get/set the current index
 *   phrase        current phrase object (read-only)
 *   normalizer    get/set the SpeakerNormalizer. Settable so a host can
 *                 share one speaker reference across several components or
 *                 restore a calibrated one from another page — register
 *                 state is per-speaker, not per-widget.
 *   ready         true once the engine has loaded (read-only)
 *   calibrating   true while a calibration pass is running (read-only)
 *
 * METHODS
 *   load()             boot the engine; idempotent, returns a Promise
 *   next() / prev()    move through the curriculum (wraps)
 *   reset()            clear the current attempt's feedback
 *   startCalibration() run a calibration pass now (forces one even if the
 *                      normalizer is already calibrated)
 *   skipCalibration()  abandon the running pass
 *
 * EVENTS (all bubble and cross the shadow boundary)
 *   ready          engine loaded, component usable
 *   error          {message} — engine boot or mic failure
 *   phrasechange   {index, phrase}
 *   attempt        the full scored result — see buildAttemptDetail() for the
 *                  payload. This is the hook an experiment app records.
 *   calibrationstart {total}
 *   calibrationend   {completed, skipped, registerTrusted} — an experiment
 *                  app should treat this as the start of its trial phase,
 *                  since attempts before it were scored shape-only.
 * ---------------------------------------------------------------------
 *
 * Scoring notes that matter for interpreting the output:
 *
 *   - Everything is scored against SURFACE (post-sandhi) tones, never
 *     citation tones: that is what the learner actually has to produce, and
 *     it is what the target band is drawn from. The citation tone is shown
 *     alongside, struck through, for pedagogical transparency.
 *   - Neutral-tone syllables are shown but NOT scored, and are excluded
 *     from the aggregate (see classifier.js's tone-0 guard).
 *   - The speaker normalizer is updated once, AFTER the whole utterance has
 *     been classified (commitUtteranceToNormalizer), so an utterance is
 *     scored against the register as it stood before it began.
 *   - A calibration pass runs before any phrase work (one "ma" per tone),
 *     using the SAME CalibrationSession the single-word app uses
 *     (../single-word/calibration.js) so the two flows cannot drift. It is
 *     skipped automatically when the normalizer is already calibrated —
 *     including one injected via the `normalizer` property — and can be
 *     suppressed with `skip-calibration`. Calibration prompts are
 *     monosyllables scored through the single-syllable path and are never
 *     graded. Until it completes (or enough varied practice accumulates)
 *     the classifier is shape-only; the status row always shows which
 *     regime is live rather than hiding it.
 */

import { createRecorder, encodeWav } from '../single-word/audio.js';
import { ensureReady, analyzeWav } from '../single-word/praat-engine.js';
import { ensureDenoiseReady, denoise } from '../single-word/denoise.js';
import { SpeakerNormalizer, extractFeatures } from '../single-word/features.js';
import { CalibrationSession, shouldCalibrate } from '../single-word/calibration.js';
import {
  extractUtteranceFeatures, classifyUtterance, commitUtteranceToNormalizer
} from '../single-word/utterance.js';
import { renderUtterance } from '../single-word/viz.js';
import { loadTargets, getSyllableTargets } from '../single-word/targets.js';
import { PHRASES, spokenPinyin, isSandhi, acceptedFor, isOptional } from './phrases.js';
import {
  VERDICT_LABEL, UNCERTAIN_REASON_TEXT, aggregate, summaryHtml,
  buildAttemptDetail, escapeHtml
} from './result.js';
import { COMPONENT_CSS } from './styles.js';

const TEMPLATE = `
<div class="root">
  <div class="calib-banner hidden" data-el="calib">
    <p>First, let's hear your natural pitch range. Say each of these the way
      you'd normally say them:
      <span class="tones"><b class="t1">m&#257;</b> &middot; <b class="t2">m&#225;</b>
      &middot; <b class="t3">m&#462;</b> &middot; <b class="t4">m&#224;</b></span>
    </p>
    <div class="row">
      <span class="progress" data-el="calib-progress"></span>
      <button class="ghost-btn" data-el="calib-skip" type="button">Skip</button>
    </div>
  </div>

  <div class="phrase-row">
    <button class="nav-btn" data-nav="prev" type="button" aria-label="Previous phrase">&lsaquo;</button>
    <div class="phrase-display">
      <div class="hanzi" data-el="hanzi"></div>
      <div class="gloss" data-el="gloss"></div>
    </div>
    <button class="nav-btn" data-nav="next" type="button" aria-label="Next phrase">&rsaquo;</button>
  </div>

  <div class="note" data-el="note"></div>

  <div class="syllable-canvases" data-el="canvases"></div>
  <div class="syllable-row" data-el="chips"></div>

  <div class="controls">
    <button class="record-btn" data-el="record" disabled>
      <span class="dot"></span>
      <span data-el="record-label">Hold to speak</span>
    </button>
    <button class="ghost-btn" data-el="play" type="button" disabled>Play your voice</button>
  </div>

  <div class="mic-meter" aria-hidden="true"><div data-el="meter"></div></div>

  <div class="summary" data-el="summary" aria-live="polite"></div>
  <div class="warn hidden" data-el="warn"></div>

  <div class="status-row">
    <span data-el="engine">Loading analyzer…</span>
    <span data-el="register"></span>
  </div>

  <div class="error hidden" data-el="error" aria-live="polite"></div>
</div>
`;

export class TonePhraseTrainer extends HTMLElement {
  static get observedAttributes () {
    return ['phrase-index', 'hide-nav', 'hide-playback'];
  }

  constructor () {
    super();
    this._phrases = PHRASES;
    this._index = 0;
    this._normalizer = new SpeakerNormalizer();
    this._recorder = null;
    this._lastWavBlob = null;
    this._meterRaf = 0;
    this._ready = false;
    this._loadPromise = null;
    this._built = false;
    this._lastAttempt = null;
    this._calibration = null;
  }

  /* ---------------- lifecycle ---------------- */

  connectedCallback () {
    if (!this._built) this._build();
    // Focusable so the scoped spacebar hold below can reach it. Not forced
    // if the host already set its own tabindex.
    if (!this.hasAttribute('tabindex')) this.setAttribute('tabindex', '0');
    this._render();
    if (!this.hasAttribute('defer')) this.load();
  }

  /*
   * A component that can be added and removed from a host app MUST give the
   * microphone back on teardown, or the browser's recording indicator stays
   * lit for the rest of the session and the audio graph leaks. (The
   * single-word app never calls dispose(); here it is not optional.)
   */
  disconnectedCallback () {
    cancelAnimationFrame(this._meterRaf);
    this._meterRaf = 0;
    if (this._recorder) {
      try { this._recorder.dispose(); } catch (err) { console.warn(err); }
      this._recorder = null;
    }
  }

  attributeChangedCallback (name, _old, value) {
    if (!this._built) return;
    if (name === 'phrase-index') {
      const i = Number(value);
      if (Number.isInteger(i) && i !== this._index) this.phraseIndex = i;
    } else if (name === 'hide-nav') {
      this._applyChrome();
    } else if (name === 'hide-playback') {
      this._applyChrome();
    }
  }

  /* ---------------- public API ---------------- */

  get phrases () { return this._phrases; }
  set phrases (list) {
    if (!Array.isArray(list) || list.length === 0) return;
    this._phrases = list;
    this._index = 0;
    if (this._built) { this._render(); this._emitPhraseChange(); }
  }

  get phraseIndex () { return this._index; }
  set phraseIndex (i) {
    if (!Number.isInteger(i) || !this._phrases.length) return;
    const n = this._phrases.length;
    const next = ((i % n) + n) % n;   // wrap, including negatives
    this._index = next;
    if (this.getAttribute('phrase-index') !== String(next)) {
      this.setAttribute('phrase-index', String(next));
    }
    if (this._built) { this._render(); this._emitPhraseChange(); }
  }

  get phrase () { return this._phrases[this._index] || null; }

  get normalizer () { return this._normalizer; }
  set normalizer (n) {
    if (!n) return;
    this._normalizer = n;
    this._updateStatusRow();
  }

  get ready () { return this._ready; }

  /** Last scored attempt's event detail, or null. Convenience for hosts. */
  get lastAttempt () { return this._lastAttempt; }

  load () {
    if (this._loadPromise) return this._loadPromise;
    this._loadPromise = (async () => {
      try {
        // ensureDenoiseReady() never throws — denoising is an enhancement,
        // and a slow or blocked CDN must not stop the component from
        // becoming usable (see denoise.js).
        await Promise.all([ensureReady(), loadTargets(), ensureDenoiseReady()]);
        this._ready = true;
        this._els.engine.textContent = 'Ready';
        this._els.record.disabled = false;
        // Calibration runs before any phrase work: until the register
        // reference is trusted the classifier is shape-only, so scoring
        // phrases first would mean scoring them in the weaker regime. An
        // already-calibrated normalizer (e.g. handed in by a host that
        // calibrated elsewhere) skips straight to practice.
        if (shouldCalibrate(this._normalizer) && !this.hasAttribute('skip-calibration')) {
          this.startCalibration();
        } else {
          this._render();
        }
        this._emit('ready', {});
      } catch (err) {
        console.error(err);
        this._ready = false;
        this._els.engine.textContent = 'Failed';
        this._showError(err.message || String(err));
        this._emit('error', { message: err.message || String(err) });
      }
    })();
    return this._loadPromise;
  }

  next () { this.phraseIndex = this._index + 1; }
  prev () { this.phraseIndex = this._index - 1; }

  reset () {
    this._lastWavBlob = null;
    this._lastAttempt = null;
    this._els.play.disabled = true;
    this._els.summary.textContent = '';
    this._els.warn.classList.add('hidden');
    this._render();
  }

  /* ---------------- construction ---------------- */

  _build () {
    const root = this.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = COMPONENT_CSS;
    root.append(style);
    const wrap = document.createElement('div');
    wrap.innerHTML = TEMPLATE;
    root.append(wrap.firstElementChild);

    this._els = {};
    root.querySelectorAll('[data-el]').forEach(n => {
      this._els[n.dataset.el] = n;
    });
    this._els.calibSkip = this._els['calib-skip'];
    this._els.calibProgress = this._els['calib-progress'];
    this._els.prev = root.querySelector('[data-nav="prev"]');
    this._els.next = root.querySelector('[data-nav="next"]');
    this._built = true;

    this._els.prev.addEventListener('click', () => this.prev());
    this._els.next.addEventListener('click', () => this.next());
    this._els.play.addEventListener('click', () => this._playback());
    this._els.calibSkip.addEventListener('click', () => this.skipCalibration());

    this._bindHold();
    this._applyChrome();

    const attr = this.getAttribute('phrase-index');
    if (attr !== null) {
      const i = Number(attr);
      if (Number.isInteger(i)) this._index = Math.max(0, i) % this._phrases.length;
    }
  }

  _applyChrome () {
    const hideNav = this.hasAttribute('hide-nav');
    this._els.prev.classList.toggle('hidden', hideNav);
    this._els.next.classList.toggle('hidden', hideNav);
    this._els.play.classList.toggle('hidden', this.hasAttribute('hide-playback'));
  }

  /*
   * Push-and-hold, via Pointer Events (one handler set covers mouse, touch
   * and stylus) plus a spacebar hold.
   *
   * The keyboard listener is bound to THIS ELEMENT, not to window as the
   * standalone single-word app does. In an embedded context a window-level
   * space handler would hijack the spacebar for the entire host page; scoped
   * here it only fires when focus is inside the component. preventDefault on
   * keydown also suppresses the synthetic click a focused button would
   * otherwise receive on keyup, which would double-fire the gesture.
   */
  _bindHold () {
    const btn = this._els.record;
    let pointerActive = false;
    let keyActive = false;

    const begin = async (release) => {
      try {
        await this._startRecording();
      } catch (err) {
        release();
        btn.classList.remove('recording');
        console.error(err);
      }
    };

    btn.addEventListener('pointerdown', (e) => {
      if (btn.disabled || pointerActive) return;
      e.preventDefault();
      pointerActive = true;
      btn.classList.add('recording');
      btn.setPointerCapture?.(e.pointerId);
      begin(() => { pointerActive = false; });
    });

    const pointerStop = async (e) => {
      if (!pointerActive) return;
      pointerActive = false;
      btn.classList.remove('recording');
      if (e && e.pointerId != null) btn.releasePointerCapture?.(e.pointerId);
      await this._stopRecording();
    };
    btn.addEventListener('pointerup', pointerStop);
    btn.addEventListener('pointercancel', pointerStop);
    btn.addEventListener('pointerleave', pointerStop);

    this.addEventListener('keydown', (e) => {
      if (e.code !== 'Space' || e.repeat || keyActive) return;
      if (btn.disabled) return;
      e.preventDefault();
      keyActive = true;
      btn.classList.add('recording');
      begin(() => { keyActive = false; });
    });

    this.addEventListener('keyup', async (e) => {
      if (e.code !== 'Space' || !keyActive) return;
      e.preventDefault();
      keyActive = false;
      btn.classList.remove('recording');
      await this._stopRecording();
    });
  }

  /* ---------------- recording ---------------- */

  async _ensureRecorder () {
    if (this._recorder) return this._recorder;
    try {
      this._recorder = await createRecorder();
      return this._recorder;
    } catch (err) {
      const msg = 'Microphone access was denied or unavailable: ' + (err.message || err);
      this._showError(msg);
      this._emit('error', { message: msg });
      throw err;
    }
  }

  async _startRecording () {
    const rec = await this._ensureRecorder();
    rec.start();
    this._startMeter();
    this._els.summary.textContent = '';
    this._els.warn.classList.add('hidden');
    this._els.play.disabled = true;
  }

  _startMeter () {
    cancelAnimationFrame(this._meterRaf);
    const tick = () => {
      if (!this._recorder || !this._recorder.isRecording) {
        this._els.meter.style.width = '0%';
        return;
      }
      this._els.meter.style.width =
        Math.round(this._recorder.getMicLevel() * 100) + '%';
      this._meterRaf = requestAnimationFrame(tick);
    };
    this._meterRaf = requestAnimationFrame(tick);
  }

  async _stopRecording () {
    if (!this._recorder) return;
    const { wav, durationSec, samples, sampleRate } = await this._recorder.stop();
    if (!wav || durationSec < 0.15) {
      this._els.summary.innerHTML =
        '<div class="diagnostic">Hold the button while you say the whole phrase.</div>';
      return;
    }

    // Snapshot for playback BEFORE analysis: analyzeWav transfers the
    // ArrayBuffer to the Praat worker, detaching it on this thread, so a
    // Blob built afterwards would be empty. Playback uses the original
    // capture; only the analysis copy is denoised.
    this._lastWavBlob = new Blob([wav], { type: 'audio/wav' });
    this._els.play.disabled = this.hasAttribute('hide-playback');
    this._els.summary.innerHTML = '<div class="diagnostic">Listening…</div>';

    try {
      let analysisWav = wav;
      try {
        analysisWav = encodeWav(await denoise(samples, sampleRate), sampleRate);
      } catch (err) {
        console.warn('Denoising unavailable, scoring original audio:', err);
      }
      const analysis = await analyzeWav(analysisWav);
      if (this.calibrating) this._scoreCalibration(analysis);
      else this._score(analysis, durationSec);
    } catch (err) {
      console.error(err);
      this._els.summary.innerHTML =
        '<div class="diagnostic">Couldn\'t analyze that: ' +
        escapeHtml(err.message || 'try again.') + '</div>';
    }
  }

  /* ---------------- scoring ---------------- */

  _score (analysis, durationSec) {
    const phrase = this.phrase;
    if (!phrase) return;
    const surface = phrase.surfaceTones;

    // acceptedTones is threaded into BOTH the boundary search and the
    // scoring, so a position that legitimately accepts two realizations is
    // never judged against one arbitrary choice (see sandhi.js).
    const accepted = phrase.syllables.map((_s, i) => acceptedFor(phrase, i));
    const res = extractUtteranceFeatures(analysis, this._normalizer, surface, accepted);
    if (!res.voiced) {
      this._els.summary.innerHTML =
        '<div class="diagnostic">' +
        escapeHtml(UNCERTAIN_REASON_TEXT[res.reason] || 'Try again.') +
        '</div>';
      this._render();
      this._emitAttempt(phrase, null, null, res, durationSec);
      return;
    }

    const verdicts = classifyUtterance(res.syllables, surface, accepted);
    // Register update happens once, after the whole utterance is scored,
    // labelled with the tone actually produced rather than the displayed
    // one — that label feeds the normalizer's tone-diversity gate.
    const producedTones = verdicts.map((v, i) =>
      (v && v.matchedTone !== undefined && v.matchedTone !== null) ? v.matchedTone : surface[i]);
    commitUtteranceToNormalizer(this._normalizer, res.syllables, producedTones);

    this._paint(phrase, res, verdicts);
    this._updateStatusRow();
    this._emitAttempt(phrase, res.syllables, verdicts, res, durationSec);
  }

  /* ---------------- calibration ---------------- */

  /** True while a calibration pass is running. */
  get calibrating () {
    return !!(this._calibration && this._calibration.active);
  }

  /**
   * Start a calibration pass. Safe to call directly — a host driving its own
   * protocol can force one even on an already-calibrated normalizer.
   */
  startCalibration () {
    this._calibration = new CalibrationSession(this._normalizer);
    if (!this._calibration.active) { this._exitCalibration(); return; }
    this._els.calib.classList.remove('hidden');
    this._els.prev.disabled = true;
    this._els.next.disabled = true;
    this._els.summary.textContent = '';
    this._els.warn.classList.add('hidden');
    this._render();
    this._emit('calibrationstart', { total: this._calibration.total });
  }

  /** Abandon the pass: passive accumulation, stricter trust bar, no lowering. */
  skipCalibration () {
    if (!this._calibration) return;
    this._calibration.skip();
    this._exitCalibration();
  }

  /**
   * One calibration utterance came in. Uses the SINGLE-syllable path
   * (extractFeatures) — the prompts are monosyllables, so running them
   * through the phrase segmenter would be both wrong and pointless.
   * Calibration is not graded: any utterance that clears the voicing gates
   * counts, because the point is to measure the voice, not judge it.
   */
  _scoreCalibration (analysis) {
    const word = this._calibration.item;
    const features = extractFeatures(analysis, this._normalizer);
    if (!features.voiced) {
      this._els.summary.innerHTML = '<div class="diagnostic">' +
        escapeHtml(UNCERTAIN_REASON_TEXT[features.reason] || 'Try again.') +
        '</div>';
      return;
    }
    this._normalizer.add(features.referenceFrames, word.tone);

    const stillCalibrating = this._calibration.accept();
    if (stillCalibrating) {
      this._render();
      this._els.summary.innerHTML = '<strong>\u2713 Got it</strong>';
    } else {
      this._exitCalibration();
      this._els.summary.innerHTML = '<strong>\u2713 Pitch range set</strong>';
    }
  }

  _exitCalibration () {
    const completed = !!(this._calibration && this._calibration.completed);
    this._els.calib.classList.add('hidden');
    this._applyChrome();
    this._els.prev.disabled = false;
    this._els.next.disabled = false;
    this._render();
    this._updateStatusRow();
    this._emit('calibrationend', {
      completed,
      skipped: !!(this._calibration && this._calibration.skipped),
      registerTrusted: this._normalizer.isRegisterTrusted()
    });
  }

  /** Draw the current calibration prompt through the same layout as a phrase. */
  _renderCalibration () {
    const word = this._calibration.item;
    if (!word) return;
    this._els.hanzi.textContent = word.hanzi;
    this._els.gloss.textContent = word.gloss || '';
    this._els.note.textContent = 'Say it the way you normally would — this one isn\'t marked.';
    this._els.calibProgress.textContent = this._calibration.progressLabel;

    const entry = this._ready ? getSyllableTargets(word.syllable)[word.tone] : null;
    renderUtterance(this._els.canvases, [{
      tone: word.tone,
      coefs: entry ? entry.coefs : null,
      features: null,
      neutral: false
    }]);
    this._els.chips.style.setProperty('--syllable-count', '1');
    this._els.chips.innerHTML =
      '<div class="chip idle"><span class="pinyin t' + word.tone + '">' +
      escapeHtml(word.pinyin) + '</span></div>';
  }

  /* ---------------- rendering ---------------- */

  /** Draw whichever mode is active. Single entry point for every caller. */
  _render () {
    if (!this._built) return;
    if (this.calibrating) this._renderCalibration();
    else this._renderPhrase();
  }

  /** Target {tone, coefs} for syllable i, or null for a neutral syllable. */
  _targetFor (phrase, i) {
    const surfaceTone = phrase.surfaceTones[i];
    if (surfaceTone === 0) return null;
    // The band is the SURFACE tone's shape — the acoustically correct thing
    // to aim at — not the citation tone's.
    const entry = getSyllableTargets(phrase.syllables[i].base)[surfaceTone];
    return entry ? { tone: surfaceTone, coefs: entry.coefs, source: entry.source } : null;
  }

  /** Idle: phrase text, target bands only, chips with no verdict yet. */
  _renderPhrase () {
    if (!this._built) return;
    const phrase = this.phrase;
    if (!phrase) return;

    this._els.hanzi.textContent = phrase.hanzi;
    this._els.gloss.textContent = phrase.gloss || '';
    this._els.note.textContent = phrase.note || '';

    const entries = phrase.syllables.map((_s, i) => {
      const t = this._ready ? this._targetFor(phrase, i) : null;
      return {
        tone: t ? t.tone : 0,
        coefs: t ? t.coefs : null,
        features: null,
        neutral: phrase.surfaceTones[i] === 0
      };
    });
    renderUtterance(this._els.canvases, entries);
    this._els.chips.style.setProperty('--syllable-count', String(entries.length));
    this._els.chips.innerHTML = phrase.syllables
      .map((_s, i) => this._chipHtml(phrase, i, null))
      .join('');
    this._updateStatusRow();
  }

  /** After an attempt: contours over bands, chips carrying verdicts. */
  _paint (phrase, res, verdicts) {
    const entries = phrase.syllables.map((_s, i) => {
      const t = this._targetFor(phrase, i);
      return {
        tone: t ? t.tone : 0,
        coefs: t ? t.coefs : null,
        features: res.syllables[i],
        neutral: phrase.surfaceTones[i] === 0
      };
    });
    renderUtterance(this._els.canvases, entries);

    this._els.chips.style.setProperty('--syllable-count', String(entries.length));
    this._els.chips.innerHTML = phrase.syllables
      .map((_s, i) => this._chipHtml(phrase, i, verdicts[i]))
      .join('');

    const agg = aggregate(phrase, verdicts);
    this._els.summary.innerHTML = summaryHtml(agg, phrase, verdicts);

    // An even-split fallback means the syllable boundaries are a best guess.
    // Say so — a confidently-wrong boundary is worse than an admitted one.
    if (res.segmentation && res.segmentation.method === 'even-split') {
      this._els.warn.textContent =
        "I couldn't tell exactly where one syllable ended and the next began, " +
        'so I split the recording evenly. Treat the per-syllable marks as a rough guide.';
      this._els.warn.classList.remove('hidden');
    } else {
      this._els.warn.classList.add('hidden');
    }
  }

  _chipHtml (phrase, i, verdict) {
    const syl = phrase.syllables[i];
    const surfaceTone = phrase.surfaceTones[i];
    const neutral = surfaceTone === 0;
    const cls = neutral ? 'neutral' : (verdict ? verdict.verdict : 'idle');
    const label = verdict
      ? (VERDICT_LABEL[verdict.verdict] || '')
      : (neutral ? VERDICT_LABEL.neutral : '');

    let html = `<div class="chip ${cls}">`;
    html += `<span class="pinyin t${surfaceTone}">${escapeHtml(spokenPinyin(phrase, i))}</span>`;
    // Citation form only when sandhi actually moved it — otherwise it is
    // noise on the screen.
    if (isSandhi(phrase, i)) {
      html += `<span class="citation">${escapeHtml(syl.pinyin)}</span>`;
    }
    // A genuinely optional position: say so, rather than showing one form
    // and silently accepting another. Without this the learner would see a
    // single prompt and have no idea the alternative was equally right.
    if (isOptional(phrase, i) && syl.altPinyin) {
      html += `<span class="alt">or ${escapeHtml(syl.altPinyin)}</span>`;
    }
    if (label) html += `<span class="mark">${escapeHtml(label)}</span>`;
    html += '</div>';
    return html;
  }

  _updateStatusRow () {
    if (!this._built) return;
    const trusted = this._normalizer.isRegisterTrusted();
    this._els.register.textContent = trusted
      ? 'Pitch range: set'
      : 'Pitch range: still learning (shape only)';
  }

  _playback () {
    if (!this._lastWavBlob) return;
    const url = URL.createObjectURL(this._lastWavBlob);
    const audio = new Audio(url);
    audio.addEventListener('ended', () => URL.revokeObjectURL(url));
    audio.play().catch(err => {
      URL.revokeObjectURL(url);
      console.error('Playback failed:', err);
    });
  }

  _showError (msg) {
    this._els.error.textContent = msg;
    this._els.error.classList.remove('hidden');
  }

  /* ---------------- events ---------------- */

  _emit (type, detail) {
    // bubbles + composed so a host listening on an ancestor outside the
    // shadow root actually receives these.
    this.dispatchEvent(new CustomEvent(type, {
      detail, bubbles: true, composed: true
    }));
  }

  _emitPhraseChange () {
    this._emit('phrasechange', { index: this._index, phrase: this.phrase });
  }

  _emitAttempt (phrase, syllableFeatures, verdicts, res, durationSec) {
    const detail = buildAttemptDetail(
      phrase, syllableFeatures, verdicts, res, durationSec,
      this._normalizer.isRegisterTrusted()
    );
    this._lastAttempt = detail;
    this._emit('attempt', detail);
  }
}

if (!customElements.get('tone-phrase-trainer')) {
  customElements.define('tone-phrase-trainer', TonePhraseTrainer);
}
