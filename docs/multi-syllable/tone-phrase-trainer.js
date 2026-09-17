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
 *   hide-playback   hide both playback controls — each is a play button
 *                   plus a download icon, and the attribute hides the pair
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
 *   playRecording()    play the last recording back, untouched
 *   playCorrected()    play the last recording with the tones corrected;
 *                      resolves once playback has been started. No-op when
 *                      there is nothing correctable (see below)
 *   downloadRecording()  save the untouched recording as a .wav
 *   downloadCorrected()  save the corrected recording as a .wav; synthesizes
 *                      it first if the learner never pressed play
 *
 * Downloads are named `<pinyin>-<orig|corrected>-<YYYYMMDD>-<HHMMSS>.wav`
 * from the SURFACE tones of the current prompt — 你好 files as
 * `ni2hao3-orig-…`, matching both what the learner was asked to say and this
 * project's own corpus naming (see recordingFilename in audio.js).
 *   startCalibration() run a calibration pass now (forces one even if the
 *                      normalizer is already calibrated)
 *   skipCalibration()  abandon the running pass
 *
 * EVENTS (all bubble and cross the shadow boundary)
 *   ready          engine loaded, component usable
 *   error          {message} — engine boot, mic, or resynthesis failure
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
 *   - After a scored attempt the learner can hear their OWN recording with
 *     the tones corrected ("play your corrected voice"). This is PSOLA
 *     manipulation of their own audio, not a native-speaker model: voice,
 *     timing and words are untouched and only F0 moves, so the learner is
 *     comparing against something they can actually imitate — themselves.
 *     The contour imposed is the target the syllable was scored against,
 *     anchored the way the score was anchored, so the audio and the mark
 *     cannot disagree (docs/single-word/pitch-correct.js has the full
 *     rules). That is also the canvas band everywhere except a genuinely
 *     optional sandhi position, where the canvas shows the surface form but
 *     the correction follows the form the learner was credited for. It
 *     corrects
 *     PITCH ONLY: the classifier also weighs duration (T4 is the short
 *     tone, T3 the long one), so a corrected syllable held far too long can
 *     still be scored wrong — the feature does not, and should not, retime
 *     the learner's speech. The button stays disabled when there is nothing
 *     honest to correct: an unscored utterance, or a phrase whose every
 *     syllable is neutral. Either recording can also be downloaded from the
 *     icon beside its play button.
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

import {
  createRecorder, encodeWav, recordingFilename, downloadBlob
} from '../single-word/audio.js';
import { ensureReady, analyzeWav, resynthesizeWithPitch } from '../single-word/praat-engine.js';
import { ensureDenoiseReady, denoise } from '../single-word/denoise.js';
import { SpeakerNormalizer, extractFeatures } from '../single-word/features.js';
import { CalibrationSession, shouldCalibrate } from '../single-word/calibration.js';
import {
  extractUtteranceFeatures, scoreUtterance, commitUtteranceToNormalizer
} from '../single-word/utterance.js';
import { renderUtterance } from '../single-word/viz.js';
import { buildCorrectedPitchPoints } from '../single-word/pitch-correct.js';
import { loadTargets } from '../single-word/targets.js';
import { buildReferences } from '../single-word/tone-match.js';
import { PHRASES, spokenPinyin, isSandhi, acceptedFor, isOptional } from './phrases.js';
import {
  VERDICT_LABEL, UNCERTAIN_REASON_TEXT, aggregate, summaryHtml,
  buildAttemptDetail, escapeHtml
} from './result.js';
import { COMPONENT_CSS } from './styles.js';

/*
 * Download glyph — arrow into a tray. Inline rather than a font or an <img>
 * because the component ships as one self-contained file with no assets of
 * its own; `currentColor` lets it inherit whatever the host themes the
 * button text to.
 */
const DOWNLOAD_ICON = `
<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" focusable="false">
  <path d="M8 1.5v7.5m0 0L5.2 6.2M8 9l2.8-2.8" fill="none" stroke="currentColor"
    stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M2.5 11v1.8a1.2 1.2 0 0 0 1.2 1.2h8.6a1.2 1.2 0 0 0 1.2-1.2V11"
    fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
</svg>`;

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
  <!-- The band is a SUFFICIENT condition, not a necessary one: staying inside
       it guarantees a good mark, but a correct production may still leave it
       briefly (see tone-match.js). The caption promises only what is true. -->
  <p class="band-legend">Keep your line inside the shaded band and the tone counts as right.</p>
  <div class="syllable-row" data-el="chips"></div>

  <div class="controls">
    <button class="record-btn" data-el="record" disabled>
      <span class="dot"></span>
      <span data-el="record-label">Hold to speak</span>
    </button>
    <span class="btn-pair" data-el="play-group">
      <button class="ghost-btn" data-el="play" type="button" disabled>Play your voice</button>
      <button class="icon-btn" data-el="save" type="button" disabled
        title="Download your recording" aria-label="Download your recording">${DOWNLOAD_ICON}</button>
    </span>
    <span class="btn-pair" data-el="play-fixed-group">
      <button class="ghost-btn" data-el="play-fixed" type="button" disabled
        title="Hear your own recording with the tones corrected">Play your corrected voice</button>
      <button class="icon-btn" data-el="save-fixed" type="button" disabled
        title="Download the corrected recording"
        aria-label="Download the corrected recording">${DOWNLOAD_ICON}</button>
    </span>
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
    this._correction = null;        // pitch points for the last attempt, or null
    this._correctedWavBlob = null;  // resynthesis result, built on first need
    this._correctionPromise = null; // in-flight resynthesis, shared by play + download
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
    // Corrected audio is tied to the phrase it was built for. Leaving it
    // playable after a phrase change would offer the learner "your voice,
    // corrected" for a phrase they are no longer looking at.
    if (this._built) { this._clearCorrection(); this._render(); this._emitPhraseChange(); }
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
    this._enableRawPlayback(false);
    this._clearCorrection();
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
    this._els.playFixed = this._els['play-fixed'];
    this._els.saveFixed = this._els['save-fixed'];
    this._els.playGroup = this._els['play-group'];
    this._els.playFixedGroup = this._els['play-fixed-group'];
    this._els.calibSkip = this._els['calib-skip'];
    this._els.calibProgress = this._els['calib-progress'];
    this._els.prev = root.querySelector('[data-nav="prev"]');
    this._els.next = root.querySelector('[data-nav="next"]');
    this._built = true;

    this._els.prev.addEventListener('click', () => this.prev());
    this._els.next.addEventListener('click', () => this.next());
    this._els.play.addEventListener('click', () => this.playRecording());
    this._els.playFixed.addEventListener('click', () => this.playCorrected());
    this._els.save.addEventListener('click', () => this.downloadRecording());
    this._els.saveFixed.addEventListener('click', () => this.downloadCorrected());
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
    const hidePlayback = this.hasAttribute('hide-playback');
    this._els.playGroup.classList.toggle('hidden', hidePlayback);
    this._els.playFixedGroup.classList.toggle('hidden', hidePlayback);
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
    this._enableRawPlayback(false);
    this._clearCorrection();
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
    this._enableRawPlayback(true);
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

    // One call produces the verdicts AND the matches the canvas is drawn from,
    // so the picture and the mark come from the same computation by
    // construction rather than by two code paths agreeing.
    const { verdicts, matches } = scoreUtterance(res.syllables, surface, accepted);

    // Built here, BEFORE the normalizer is committed below, for the same
    // reason the scoring is: the corrected audio must be anchored on the
    // register as it stood when this utterance began, so what the learner
    // hears agrees with the mark and the contour they were just shown. Only
    // the pitch points are computed now — the resynthesis itself is deferred
    // to the first click (see playCorrected), so an attempt nobody asks to
    // hear costs nothing.
    // Corrected toward the realization each syllable was SCORED against, not
    // blindly toward the displayed surface tone. They differ only where
    // sandhi leaves a position genuinely optional (a 3-long T3 run's first
    // syllable, which may be produced as T3 or T2 — see sandhi.js), and
    // there the difference matters: a learner who produced the accepted
    // alternative and was marked correct for it must not then hear their
    // correct production "corrected" into the other form.
    // The matched REFERENCE, not just the matched tone: where a tone carries
    // more than one accepted realization (T3's dipping third and half-third),
    // correcting toward the other one would rewrite a learner's correct
    // production into a different correct production.
    const correctionTargets = phrase.syllables.map((_s, i) =>
      (matches[i] && matches[i].ref) || this._refFor(phrase, i));
    this._correction =
      buildCorrectedPitchPoints(analysis, res, correctionTargets, this._normalizer);
    this._correctedWavBlob = null;
    this._correctionPromise = null;
    this._enableCorrectedPlayback(!!this._correction && !!this._lastWavBlob);
    this._els.playFixed.textContent = 'Play your corrected voice';

    // Register update happens once, after the whole utterance is scored,
    // labelled with the tone actually produced rather than the displayed
    // one — that label feeds the normalizer's tone-diversity gate.
    const producedTones = verdicts.map((v, i) =>
      (v && v.matchedTone !== undefined && v.matchedTone !== null) ? v.matchedTone : surface[i]);
    commitUtteranceToNormalizer(this._normalizer, res.syllables, producedTones);

    this._paint(phrase, res, verdicts, matches);
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

    renderUtterance(this._els.canvases, [{
      ref: this._ready ? (buildReferences(word.tone)[0] || null) : null,
      match: null,
      features: null
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

  /**
   * The reference to AIM AT for syllable i, before any attempt: the tone's
   * dominant realization (references come sorted most-common-first). Null for a
   * neutral syllable, which has no validated target.
   *
   * The tone is the SURFACE tone — the acoustically correct thing to aim at,
   * not the citation tone. After an attempt the canvas swaps to the realization
   * the learner actually matched, which is what `matches[i].ref` carries: a
   * learner who produced a perfectly good half-third should be shown the
   * half-third they hit, not the dipping third they did not aim for.
   */
  _refFor (phrase, i, tone = phrase.surfaceTones[i]) {
    if (tone === 0) return null;
    return buildReferences(tone)[0] || null;
  }

  /** Idle: phrase text, target bands only, chips with no verdict yet. */
  _renderPhrase () {
    if (!this._built) return;
    const phrase = this.phrase;
    if (!phrase) return;

    this._els.hanzi.textContent = phrase.hanzi;
    this._els.gloss.textContent = phrase.gloss || '';
    this._els.note.textContent = phrase.note || '';

    const entries = phrase.syllables.map((_s, i) => ({
      ref: this._ready ? this._refFor(phrase, i) : null,
      match: null,
      features: null
    }));
    renderUtterance(this._els.canvases, entries);
    this._els.chips.style.setProperty('--syllable-count', String(entries.length));
    this._els.chips.innerHTML = phrase.syllables
      .map((_s, i) => this._chipHtml(phrase, i, null))
      .join('');
    this._updateStatusRow();
  }

  /** After an attempt: scored contours over the matched bands, chips with verdicts. */
  _paint (phrase, res, verdicts, matches) {
    const entries = phrase.syllables.map((_s, i) => ({
      // The realization the learner matched, falling back to the aim-point when
      // there was nothing to match (unvoiced, or neutral).
      ref: (matches[i] && matches[i].ref) || this._refFor(phrase, i),
      match: matches[i] || null,
      features: res.syllables[i]
    }));
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

  /** Play back the raw recording, exactly as captured. */
  playRecording () {
    this._play(this._lastWavBlob);
  }

  /**
   * Play the learner's own recording with the tones corrected: same voice,
   * same timing, same words, F0 replaced by the target contour they were
   * just shown (see pitch-correct.js for what is and isn't corrected).
   *
   * The resynthesis is done lazily on first request and cached, so the cost
   * lands on the learner who asks for it rather than on every attempt. It
   * runs in the Praat worker, so it doesn't block the UI — but it isn't
   * instant either, hence the button state while it works.
   */
  /**
   * Play the learner's own recording with the tones corrected: same voice,
   * same timing, same words, F0 replaced by the target contour they were
   * just shown (see pitch-correct.js for what is and isn't corrected).
   * Resolves once playback has started, or immediately if there is nothing
   * to play.
   */
  async playCorrected () {
    const blob = await this._ensureCorrectedWav();
    if (blob) this._play(blob);
  }

  /** Download the recording exactly as captured. */
  downloadRecording () {
    if (!this._lastWavBlob) return;
    downloadBlob(this._lastWavBlob,
      recordingFilename(this._promptSyllables(), 'orig'));
  }

  /**
   * Download the pitch-corrected recording. Synthesizes it on the spot if
   * the learner never pressed play — downloading and listening are
   * independent things to want, and making one a precondition of the other
   * would be an artifact of how this is cached, not a real constraint.
   */
  async downloadCorrected () {
    const blob = await this._ensureCorrectedWav();
    if (blob) downloadBlob(blob, recordingFilename(this._promptSyllables(), 'corrected'));
  }

  /**
   * Syllables of the current prompt, as {base, tone}, for naming a download.
   * SURFACE tones, not citation: the file records what the learner was asked
   * to say and actually attempted, so 你好 files as ni2hao3, matching both
   * the on-screen prompt and this project's corpus naming.
   */
  _promptSyllables () {
    if (this.calibrating) {
      const w = this._calibration.item;
      return w ? [{ base: w.syllable, tone: w.tone }] : [];
    }
    const phrase = this.phrase;
    if (!phrase) return [];
    return phrase.syllables.map((syl, i) => ({
      base: syl.base,
      tone: phrase.surfaceTones[i]
    }));
  }

  /**
   * The corrected WAV, resynthesized on first need and cached thereafter.
   *
   * The in-flight promise is cached too, not just the result: play and
   * download are two buttons onto the same audio, and a learner who hits
   * both before the first finishes would otherwise run the Praat pass twice
   * and race over which result gets stored.
   */
  _ensureCorrectedWav () {
    if (this._correctedWavBlob) return Promise.resolve(this._correctedWavBlob);
    if (this._correctionPromise) return this._correctionPromise;
    if (!this._correction || !this._lastWavBlob) return Promise.resolve(null);

    const btn = this._els.playFixed;
    this._enableCorrectedPlayback(false);
    btn.textContent = 'Correcting…';

    this._correctionPromise = (async () => {
      try {
        // resynthesizeWithPitch TRANSFERS its buffer to the worker, so this
        // must be a fresh copy from the Blob — the original capture buffer
        // was already detached by the analysis pass.
        const source = await this._lastWavBlob.arrayBuffer();
        const wav = await resynthesizeWithPitch(source, this._correction.points);
        this._correctedWavBlob = new Blob([wav], { type: 'audio/wav' });
        btn.textContent = 'Play your corrected voice';
        this._enableCorrectedPlayback(true);
        return this._correctedWavBlob;
      } catch (err) {
        console.error('Pitch correction failed:', err);
        // Say so rather than leaving buttons that silently do nothing: a
        // dead control the learner keeps pressing is worse than an honest
        // one. The next attempt re-enables both.
        btn.textContent = 'Correction unavailable';
        this._emit('error', { message: err.message || String(err) });
        return null;
      } finally {
        this._correctionPromise = null;
      }
    })();
    return this._correctionPromise;
  }

  /** Shared one-shot playback; revokes the object URL when it finishes. */
  _play (blob) {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    audio.addEventListener('ended', () => URL.revokeObjectURL(url));
    audio.play().catch(err => {
      URL.revokeObjectURL(url);
      console.error('Playback failed:', err);
    });
  }

  /** Drop any corrected audio and the points it would be built from. */
  _clearCorrection () {
    this._correction = null;
    this._correctedWavBlob = null;
    this._correctionPromise = null;
    if (!this._built) return;
    this._enableCorrectedPlayback(false);
    this._els.playFixed.textContent = 'Play your corrected voice';
  }

  /*
   * Play and download are enabled and disabled together, through these two
   * helpers rather than at each call site. There is no state in which one
   * makes sense without the other, and the failure mode of letting them
   * drift is a download button that hands over the PREVIOUS attempt's audio
   * under this attempt's filename — silently wrong data, in a feature whose
   * whole purpose is to produce files someone will later analyse.
   */
  _enableRawPlayback (on) {
    const enabled = on && !this.hasAttribute('hide-playback');
    this._els.play.disabled = !enabled;
    this._els.save.disabled = !enabled;
  }

  _enableCorrectedPlayback (on) {
    const enabled = on && !this.hasAttribute('hide-playback');
    this._els.playFixed.disabled = !enabled;
    this._els.saveFixed.disabled = !enabled;
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
