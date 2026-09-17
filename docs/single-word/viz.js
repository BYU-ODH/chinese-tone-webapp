/*
 * Canvas visualization: tolerance band + the learner's scored contour.
 *
 * This module draws a tone-match.js match object and nothing else. That is the
 * whole point of it: the band's half-width IS the tolerance the verdict
 * thresholds on, and the line drawn IS the curve that was measured, so "my line
 * is inside the band" and "I was marked right" cannot disagree. Previously the
 * band was a fixed 32-pixel stroke with no relationship to the classifier at
 * all — it meant ±1.84 ST on a 210px canvas and ±2.81 ST at the narrow-screen
 * breakpoint, so resizing the browser silently changed the tolerance the picture
 * implied, and a contour drawn inside it could still be marked wrong.
 *
 * TWO THINGS ARE DELIBERATELY NOT DRAWN:
 *
 *   The raw pitch contour. What gets scored is the Legendre fit over the vowel
 *   nucleus, not the raw per-frame track, and the raw track includes ~16% of
 *   span that was never scored at all (the shoulders outside the vowel core).
 *   Drawing it would put a line on screen that the verdict does not describe,
 *   which is the exact failure this module was rewritten to remove. The fit is
 *   smoother than the truth; that is a fair trade for it being the truth about
 *   the scoring.
 *
 *   Duration. The band's x-axis is normalized per syllable, so nothing here can
 *   express how long the syllable was — and nothing needs to, because
 *   tone-match.js does not score duration. It reports it (durationRatio,
 *   durationOk) for a caller to surface as a separate, clearly non-scoring hint.
 *   The old classifier DID score it invisibly, which is why a perfectly shaped
 *   T4 held 0.8 s came back 'bad' with a picture showing a perfect match.
 *
 * Tone-color coding (matched in app.css): T1 red, T2 orange, T3 green, T4 blue.
 */

import { sampleCoefs, SAMPLES } from './tone-match.js';

const Y_MIN = -10;
const Y_MAX = 10;

const TONE_COLORS = {
  1: '#e23636',
  2: '#f59e0b',
  3: '#16a34a',
  4: '#2563eb'
};

/* ------------------------------------------------------------------ */
/*  Geometry                                                            */
/* ------------------------------------------------------------------ */

function setupCanvas (canvas) {
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth;
  const cssH = canvas.clientHeight;
  if (canvas.width !== cssW * dpr || canvas.height !== cssH * dpr) {
    canvas.width = cssW * dpr;
    canvas.height = cssH * dpr;
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w: cssW, h: cssH };
}

const PAD_X = 18;
const PAD_Y = 18;

function xToPx (x, w) { return PAD_X + x * (w - 2 * PAD_X); }
function yToPx (y, h) {
  const inner = h - 2 * PAD_Y;
  const t = (y - Y_MIN) / (Y_MAX - Y_MIN);
  return PAD_Y + (1 - t) * inner;
}

/** Normalized x for sample i of a SAMPLES-long curve. */
function sampleX (i) { return i / (SAMPLES - 1); }

function clamp (x, lo, hi) { return x < lo ? lo : (x > hi ? hi : x); }

/* ------------------------------------------------------------------ */
/*  Drawing                                                             */
/* ------------------------------------------------------------------ */

function drawAxes (ctx, w, h) {
  ctx.save();
  ctx.lineWidth = 1;

  // Centerline (speaker register).
  ctx.strokeStyle = '#cbd5e1';
  ctx.setLineDash([3, 4]);
  ctx.beginPath();
  ctx.moveTo(PAD_X, yToPx(0, h));
  ctx.lineTo(w - PAD_X, yToPx(0, h));
  ctx.stroke();

  // Faint top/bottom guides.
  ctx.strokeStyle = '#e2e8f0';
  ctx.beginPath();
  ctx.moveTo(PAD_X, yToPx(5, h));
  ctx.lineTo(w - PAD_X, yToPx(5, h));
  ctx.moveTo(PAD_X, yToPx(-5, h));
  ctx.lineTo(w - PAD_X, yToPx(-5, h));
  ctx.stroke();

  ctx.setLineDash([]);
  ctx.restore();
}

/**
 * Fill the region within `radius` semitones of `curve`.
 *
 * Built as an explicit filled polygon — top edge forward, bottom edge back —
 * rather than a thick stroke. A stroke's width is in pixels, which is how the
 * old band ended up meaning different things at different canvas heights; a
 * polygon in semitone coordinates means the same thing at every size, which is
 * what lets the drawn edge be quoted as the tolerance.
 */
function fillTube (ctx, curve, radius, w, h, color, alpha) {
  ctx.save();
  ctx.fillStyle = color;
  ctx.globalAlpha = alpha;
  ctx.beginPath();
  for (let i = 0; i < curve.length; i++) {
    const px = xToPx(sampleX(i), w);
    const py = yToPx(clamp(curve[i] + radius, Y_MIN, Y_MAX), h);
    if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
  }
  for (let i = curve.length - 1; i >= 0; i--) {
    ctx.lineTo(xToPx(sampleX(i), w), yToPx(clamp(curve[i] - radius, Y_MIN, Y_MAX), h));
  }
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

/**
 * The target: a 'close' tube, a 'good' tube inside it, and the reference
 * contour itself as a dashed guideline down the middle.
 */
function drawBand (ctx, ref, w, h) {
  const color = TONE_COLORS[ref.tone] || '#94a3b8';
  fillTube(ctx, ref.curve, ref.tolerance.close, w, h, color, 0.10);
  fillTube(ctx, ref.curve, ref.tolerance.good, w, h, color, 0.20);

  ctx.save();
  ctx.strokeStyle = color;
  ctx.globalAlpha = 0.55;
  ctx.lineWidth = 2;
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  for (let i = 0; i < ref.curve.length; i++) {
    const px = xToPx(sampleX(i), w);
    const py = yToPx(clamp(ref.curve[i], Y_MIN, Y_MAX), h);
    if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
  }
  ctx.stroke();
  ctx.restore();
}

/**
 * The learner's scored contour: their Legendre fit, moved by exactly the shift
 * the match applied. Both halves matter — the fit is what was measured, and the
 * shift is what the measurement forgave — so this is the comparison the verdict
 * was computed from, drawn.
 */
function drawScoredContour (ctx, curve, shift, w, h) {
  ctx.save();
  ctx.strokeStyle = '#0f172a';
  ctx.lineWidth = 3;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  for (let i = 0; i < curve.length; i++) {
    const px = xToPx(sampleX(i), w);
    const py = yToPx(clamp(curve[i] + shift, Y_MIN + 0.5, Y_MAX - 0.5), h);
    if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
  }
  ctx.stroke();

  // End-cap dots, so a short contour still reads as a line with direction.
  ctx.fillStyle = '#0f172a';
  for (const i of [0, curve.length - 1]) {
    ctx.beginPath();
    ctx.arc(xToPx(sampleX(i), w), yToPx(clamp(curve[i] + shift, Y_MIN + 0.5, Y_MAX - 0.5), h),
      4, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

/* ------------------------------------------------------------------ */
/*  Public API                                                          */
/* ------------------------------------------------------------------ */

/**
 * Draw one syllable.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {object} entry
 *   @param {object|null} entry.ref      the reference to aim at, from
 *     tone-match.js's buildReferences(). BEFORE an attempt the caller passes the
 *     DOMINANT realization (the first — they are sorted most-common-first);
 *     AFTER one it passes `match.ref`, the realization the learner actually
 *     matched. That swap is the whole reason a tone may carry more than one
 *     shape: T3's dipping third and half-third are both correct, and a learner
 *     who produced one should not be shown the other as their target. Null for a
 *     neutral syllable, which has no validated target to draw.
 *   @param {object|null} entry.match    matchSyllable() result, or null when
 *     idle/unvoiced. Supplies the contour's vertical shift.
 *   @param {object|null} entry.features extractSyllableFeatures() struct; its
 *     `coefs` are the fit that gets drawn.
 */
export function renderSyllable (canvas, entry) {
  const { ctx, w, h } = setupCanvas(canvas);
  ctx.clearRect(0, 0, w, h);
  drawAxes(ctx, w, h);

  const ref = entry && entry.ref;
  if (ref) drawBand(ctx, ref, w, h);

  const features = entry && entry.features;
  if (features && features.voiced && Array.isArray(features.coefs)) {
    // Shift comes from the match so the picture is the scored comparison. With
    // no match (an unscored syllable) the contour is drawn where it actually
    // sits, unmoved, rather than being quietly aligned to something.
    const shift = (entry.match && Number.isFinite(entry.match.shift)) ? entry.match.shift : 0;
    drawScoredContour(ctx, sampleCoefs(features.coefs), shift, w, h);
  }
}

/** Show only the target band — used while idle, before any recording. */
export function renderTargetOnly (canvas, ref) {
  renderSyllable(canvas, { ref, match: null, features: null });
}

/* ------------------------------------------------------------------ */
/*  Multi-syllable                                                      */
/* ------------------------------------------------------------------ */

/**
 * Render one small canvas per syllable of a multi-syllable utterance.
 *
 * Deliberately N separate canvases reusing renderSyllable()'s exact drawing
 * path, rather than one wide canvas with multi-segment x-axis logic: each
 * syllable then keeps the same normalized 0..1 x-axis and fixed semitone y-axis
 * the single-word app uses, so a syllable in a phrase and the same syllable
 * drilled alone are drawn identically and are visually comparable. It also means
 * there is no new geometry code to get wrong.
 *
 * Canvas ELEMENTS are owned here (created and reused in place) because their
 * count varies per phrase and their DPR sizing already lives in this file;
 * everything else about the per-syllable UI — chips, labels, verdict colors —
 * stays with the caller, which is what keeps this module presentation-free.
 *
 * @param {HTMLElement} container  emptied/reused; gets one <canvas> per entry
 * @param {Array<object|null>} entries  renderSyllable entries, in syllable order
 * @returns {HTMLCanvasElement[]} the canvases, in order
 */
export function renderUtterance (container, entries) {
  const canvases = ensureCanvases(container, entries.length);
  entries.forEach((e, i) => renderSyllable(canvases[i], e));
  return canvases;
}

/**
 * Make `container` hold exactly `count` canvases, reusing the existing ones
 * when the count already matches so a re-render doesn't churn the DOM (and
 * doesn't reset canvas backing stores mid-session). Also publishes the count
 * as `--syllable-count` so a stylesheet can lay the row out with
 * `grid-template-columns: repeat(var(--syllable-count), 1fr)` without the
 * caller having to compute widths.
 */
function ensureCanvases (container, count) {
  const existing = Array.from(container.querySelectorAll('canvas'));
  if (existing.length !== count) {
    container.textContent = '';
    for (let i = 0; i < count; i++) {
      const c = document.createElement('canvas');
      c.className = 'syllable-canvas';
      c.setAttribute('aria-label', `Pitch contour, syllable ${i + 1} of ${count}`);
      container.appendChild(c);
    }
  }
  container.style.setProperty('--syllable-count', String(count));
  return Array.from(container.querySelectorAll('canvas'));
}
