/*
 * Mic capture + WAV encoding.
 *
 * Push-and-hold recorder. Buffers Float32 samples from an AudioWorklet
 * while recording is active, then encodes 16-bit PCM WAV on stop.
 *
 * Usage:
 *   const rec = await createRecorder();
 *   rec.start();
 *   ...
 *   const { wav, sampleRate, durationSec } = await rec.stop();
 *   const level = rec.getMicLevel();   // 0..1, smoothed RMS
 *   rec.dispose();
 *
 * echoCancellation/noiseSuppression/autoGainControl default to false —
 * the production app (app.js) has always called createRecorder() with no
 * args, relying on these defaults, with zero explanatory comment anywhere
 * in git history for why (flagged in DISCUSSION_REMINDERS.md; likely
 * deliberate, since these DSP paths can distort pitch tracking, but
 * unconfirmed). Parameterized here for Stage 2 Track A: a live-browser
 * paired A/B (see audio-ab-test.html) comparing constraints on vs. off
 * through the unmodified analysis pipeline, to resolve this with a
 * measurement instead of an assumption.
 */

const WORKLET_SOURCE = `
class RecorderProcessor extends AudioWorkletProcessor {
  constructor () {
    super();
    this._capturing = false;
    this.port.onmessage = (e) => {
      if (e.data && e.data.type === 'start') this._capturing = true;
      else if (e.data && e.data.type === 'stop') this._capturing = false;
    };
  }
  process (inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const ch0 = input[0];
    if (!ch0) return true;
    if (this._capturing) {
      // Copy because the buffer is reused by the audio thread.
      this.port.postMessage(ch0.slice(0));
    }
    return true;
  }
}
registerProcessor('recorder-processor', RecorderProcessor);
`;

export async function createRecorder ({
  echoCancellation = false,
  noiseSuppression = false,
  autoGainControl = false
} = {}) {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    throw new Error('Microphone API unavailable in this browser.');
  }

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation,
      noiseSuppression,
      autoGainControl
    }
  });

  const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  // Some browsers start the context in suspended state until a user gesture;
  // start was almost certainly triggered by one, but resume defensively.
  if (audioCtx.state === 'suspended') await audioCtx.resume();

  const workletUrl = URL.createObjectURL(
    new Blob([WORKLET_SOURCE], { type: 'application/javascript' })
  );
  await audioCtx.audioWorklet.addModule(workletUrl);
  URL.revokeObjectURL(workletUrl);

  const source = audioCtx.createMediaStreamSource(stream);

  const analyser = audioCtx.createAnalyser();
  analyser.fftSize = 1024;
  analyser.smoothingTimeConstant = 0.7;
  const meterBuf = new Float32Array(analyser.fftSize);

  const recorder = new AudioWorkletNode(audioCtx, 'recorder-processor');
  source.connect(analyser);
  source.connect(recorder);
  // The worklet must be connected to the destination for `process` to run
  // in some browsers, but we don't want to hear the mic. Route through
  // a zero-gain node.
  const muteGain = audioCtx.createGain();
  muteGain.gain.value = 0;
  recorder.connect(muteGain).connect(audioCtx.destination);

  /** @type {Float32Array[]} */
  let chunks = [];
  let recording = false;
  let startTime = 0;

  recorder.port.onmessage = (e) => {
    if (recording && e.data instanceof Float32Array) {
      chunks.push(e.data);
    }
  };

  function start () {
    chunks = [];
    recording = true;
    startTime = audioCtx.currentTime;
    recorder.port.postMessage({ type: 'start' });
  }

  async function stop () {
    if (!recording) {
      return { wav: null, sampleRate: audioCtx.sampleRate, durationSec: 0 };
    }
    recording = false;
    recorder.port.postMessage({ type: 'stop' });

    // Drain: wait long enough to (a) collect in-flight messages and (b)
    // capture the tail we'd otherwise have to truncate. AudioWorklet
    // posts at ~128-sample granularity (~3 ms), so 60 ms is generous.
    await new Promise(r => setTimeout(r, 60));

    const sampleRate = audioCtx.sampleRate;
    const total = chunks.reduce((n, c) => n + c.length, 0);
    const all = new Float32Array(total);
    let off = 0;
    for (const c of chunks) {
      all.set(c, off);
      off += c.length;
    }
    chunks = [];

    // Trim transients: trackpad/key click on press and release leaks into
    // the mic. 80 ms off the head covers the press click; 100 ms off the
    // tail covers release + a typical lift-off motion. If the recording
    // is too short for that, return null and let the caller prompt for
    // another try.
    const trimHead = Math.round(0.080 * sampleRate);
    const trimTail = Math.round(0.100 * sampleRate);
    const usable = total - trimHead - trimTail;
    if (usable < Math.round(0.100 * sampleRate)) {
      return { wav: null, sampleRate, durationSec: total / sampleRate };
    }
    const samples = all.subarray(trimHead, trimHead + usable);
    const wav = encodeWav(samples, sampleRate);
    return { wav, sampleRate, durationSec: usable / sampleRate, samples };
  }

  function getMicLevel () {
    analyser.getFloatTimeDomainData(meterBuf);
    let sum = 0;
    for (let i = 0; i < meterBuf.length; i++) sum += meterBuf[i] * meterBuf[i];
    const rms = Math.sqrt(sum / meterBuf.length);
    return Math.min(1, rms * 4); // mild gain for visual range
  }

  function dispose () {
    try { recorder.disconnect(); } catch (_) { /* ignore */ }
    try { source.disconnect(); } catch (_) { /* ignore */ }
    try { analyser.disconnect(); } catch (_) { /* ignore */ }
    try { muteGain.disconnect(); } catch (_) { /* ignore */ }
    for (const t of stream.getTracks()) t.stop();
    audioCtx.close().catch(() => {});
  }

  return {
    start,
    stop,
    getMicLevel,
    dispose,
    get sampleRate () { return audioCtx.sampleRate; },
    get isRecording () { return recording; }
  };
}

/**
 * Encode Float32 mono PCM to a 16-bit WAV ArrayBuffer.
 * Praat-WASM accepts WAV via readAudio.
 */
export function encodeWav (samples, sampleRate) {
  const numSamples = samples.length;
  const blockAlign = 2;          // 1 channel × 16-bit
  const byteRate = sampleRate * blockAlign;
  const dataSize = numSamples * blockAlign;
  const buf = new ArrayBuffer(44 + dataSize);
  const v = new DataView(buf);
  let p = 0;
  function s (str) { for (let i = 0; i < str.length; i++) v.setUint8(p++, str.charCodeAt(i)); }
  function u32 (n) { v.setUint32(p, n, true); p += 4; }
  function u16 (n) { v.setUint16(p, n, true); p += 2; }
  s('RIFF');
  u32(36 + dataSize);
  s('WAVE');
  s('fmt ');
  u32(16);            // PCM chunk size
  u16(1);             // PCM format
  u16(1);             // mono
  u32(sampleRate);
  u32(byteRate);
  u16(blockAlign);
  u16(16);            // bits per sample
  s('data');
  u32(dataSize);
  for (let i = 0; i < numSamples; i++) {
    let x = Math.max(-1, Math.min(1, samples[i]));
    x = x < 0 ? x * 0x8000 : x * 0x7FFF;
    v.setInt16(p, x | 0, true);
    p += 2;
  }
  return buf;
}

/* ------------------------------------------------------------------ */
/*  Saving a recording                                                  */
/* ------------------------------------------------------------------ */

/**
 * Tone-numbered ASCII form of one syllable: {base:'hao', tone:3} -> 'hao3'.
 *
 * Tone NUMBERS rather than the diacritics shown on screen, because this ends
 * up in a filename: 'nǐ' is not portable across filesystems, and stripping
 * the diacritic to 'ni' would throw away the one piece of information this
 * whole app is about. Numbered pinyin is also exactly how the project's own
 * corpora name their files (ba1-01.mp3, bei3jing1, yu3yan2), so a downloaded
 * recording drops straight into that world.
 *
 * Neutral syllables carry no digit — ba4ba, not ba4ba0 — again matching the
 * corpus convention.
 *
 * `base` is already plain ASCII for every syllable in this project's
 * curricula (targets.json spells ü as v: lv, nve), but the phrase list is
 * host-replaceable, so anything unexpected is normalized rather than trusted.
 */
function toneNumbered (syllable) {
  const raw = String((syllable && (syllable.base || syllable.syllable)) || '');
  const base = raw
    .toLowerCase()
    .replace(/[üǖǘǚǜ]/g, 'v')       // corpus spelling for ü
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // strip tone diacritics
    .replace(/[^a-z0-9]/g, '');
  const tone = Number(syllable && syllable.tone);
  return base + (tone >= 1 && tone <= 4 ? String(tone) : '');
}

/** Local date and time as YYYYMMDD-HHMMSS. */
function timestamp (date) {
  const pad = n => String(n).padStart(2, '0');
  const d = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
  const t = `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  return `${d}-${t}`;
}

/**
 * Filename for a downloaded recording:
 * `<pinyin>-<kind>-<YYYYMMDD>-<HHMMSS>.wav`, e.g.
 * `ni2hao3-orig-20260916-143052.wav`.
 *
 * Seconds resolution, not just the date: a learner drills the same prompt
 * repeatedly, so a date-only stamp would have every attempt at one phrase
 * collide and arrive as "ni2hao3-orig-20260916 (3).wav" — or overwrite,
 * depending on the browser. The time is what makes the attempts distinct
 * and orderable.
 *
 * LOCAL time, not UTC: the learner is naming files for themselves, and a
 * recording made at 9pm should not be filed under tomorrow.
 *
 * @param {Array<{base?:string, syllable?:string, tone:number}>} syllables
 *   in order. For a phrase, pass the SURFACE tones — what the learner was
 *   asked to say, and what the recording is evidence about.
 * @param {'orig'|'corrected'} kind
 * @param {Date} [when]
 */
export function recordingFilename (syllables, kind, when = new Date()) {
  const pinyin = (syllables || []).map(toneNumbered).join('');
  return `${pinyin || 'recording'}-${kind}-${timestamp(when)}.wav`;
}

/**
 * Hand a Blob to the browser's downloader under `filename`.
 *
 * The object URL is revoked on a timer rather than immediately: revoking in
 * the same tick races the download in some browsers, which have only queued
 * the fetch by the time click() returns.
 */
export function downloadBlob (blob, filename) {
  if (!blob) return;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
