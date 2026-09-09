/*
 * Canvas visualization: target tone band + learner pitch contour.
 *
 * The canvas Y axis is normalized semitones re speaker mean, fixed at
 * approximately [-9, +9] so children never see Hz numbers but always see
 * their voice mapped into the same space as the target. The X axis is
 * 0..1 over the voiced span of the recording.
 *
 * Tone-color coding (matched in app.css): T1 red, T2 orange, T3 green,
 * T4 blue.
 */

const Y_MIN = -10;
const Y_MAX = 10;

const TONE_COLORS = {
  1: '#e23636',
  2: '#f59e0b',
  3: '#16a34a',
  4: '#2563eb'
};

/**
 * Evaluate Legendre orders 0..3 at t in [-1, +1].
 * (Inlined here to avoid a cross-module dependency for one tiny function.)
 */
function legendreBasis (t) {
  return [
    1,
    t,
    (3 * t * t - 1) / 2,
    (5 * t * t * t - 3 * t) / 2
  ];
}

/**
 * Sample the target curve from Legendre coefficients [c0, c1, c2, c3]
 * at n points across the syllable. Returns array of {x: 0..1, y}.
 */
function targetCurveFromCoefs (coefs, n = 80) {
  const points = new Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);          // 0..1
    const tn = 2 * t - 1;           // -1..+1 (Legendre domain)
    const b = legendreBasis(tn);
    let y = 0;
    for (let k = 0; k < 4; k++) y += (coefs[k] || 0) * b[k];
    points[i] = { x: t, y };
  }
  return points;
}

/**
 * Mean of the curve over the syllable. By orthogonality of L1..L3 to L0
 * on [-1, +1], this is just c0.
 */
function targetMeanFromCoefs (coefs) { return coefs[0] || 0; }

/* ------------------------------------------------------------------ */
/*  Drawing                                                             */
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

function drawAxes (ctx, w, h) {
  ctx.save();
  ctx.lineWidth = 1;

  // Centerline (speaker mean).
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

function drawTargetBand (ctx, tone, coefs, w, h) {
  const pts = targetCurveFromCoefs(coefs);
  const color = TONE_COLORS[tone] || '#94a3b8';

  ctx.save();
  ctx.strokeStyle = color;
  ctx.globalAlpha = 0.22;
  ctx.lineWidth = 32;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(xToPx(pts[0].x, w), yToPx(pts[0].y, h));
  for (let i = 1; i < pts.length; i++) {
    ctx.lineTo(xToPx(pts[i].x, w), yToPx(pts[i].y, h));
  }
  ctx.stroke();

  // Crisp guideline within the band.
  ctx.globalAlpha = 0.55;
  ctx.lineWidth = 2;
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(xToPx(pts[0].x, w), yToPx(pts[0].y, h));
  for (let i = 1; i < pts.length; i++) {
    ctx.lineTo(xToPx(pts[i].x, w), yToPx(pts[i].y, h));
  }
  ctx.stroke();
  ctx.restore();
}

function drawLearnerContour (ctx, times, values, yShift, w, h) {
  if (!times || times.length === 0) return;
  const t0 = times[0];
  const tN = times[times.length - 1];
  const span = tN - t0;
  if (!(span > 0)) return;

  ctx.save();
  ctx.strokeStyle = '#0f172a';
  ctx.lineWidth = 3;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  const yPx = (y) => yToPx(clamp(y + yShift, Y_MIN + 0.5, Y_MAX - 0.5), h);

  // Walk segments, breaking on NaN.
  let drawing = false;
  ctx.beginPath();
  for (let i = 0; i < times.length; i++) {
    const xn = (times[i] - t0) / span;
    const y = values[i];
    if (!Number.isFinite(y)) {
      if (drawing) { ctx.stroke(); ctx.beginPath(); drawing = false; }
      continue;
    }
    const px = xToPx(xn, w);
    const py = yPx(y);
    if (!drawing) { ctx.moveTo(px, py); drawing = true; }
    else { ctx.lineTo(px, py); }
  }
  if (drawing) ctx.stroke();

  // End-cap dots.
  ctx.fillStyle = '#0f172a';
  const firstFinite = values.findIndex(v => Number.isFinite(v));
  let lastFinite = -1;
  for (let i = values.length - 1; i >= 0; i--) {
    if (Number.isFinite(values[i])) { lastFinite = i; break; }
  }
  if (firstFinite >= 0) {
    const xn = (times[firstFinite] - t0) / span;
    ctx.beginPath();
    ctx.arc(xToPx(xn, w), yPx(values[firstFinite]), 4, 0, Math.PI * 2);
    ctx.fill();
  }
  if (lastFinite >= 0 && lastFinite !== firstFinite) {
    const xn = (times[lastFinite] - t0) / span;
    ctx.beginPath();
    ctx.arc(xToPx(xn, w), yPx(values[lastFinite]), 4, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.restore();
}

function clamp (x, lo, hi) { return x < lo ? lo : (x > hi ? hi : x); }

/* ------------------------------------------------------------------ */
/*  Public API                                                          */
/* ------------------------------------------------------------------ */

/**
 * Render the target band and (optionally) the learner contour.
 * Pass features = null to clear the learner contour.
 *
 *   target = { tone, coefs }
 *     tone is 1..4 (used for color coding)
 *     coefs is [c0, c1, c2, c3] in semitones-re-speaker-mean
 *
 * When the speaker reference isn't trusted (early in the session), the
 * contour is recentered on the target band's mean so the visualization
 * is a pure shape comparison — matching what the classifier is doing.
 * Once register is trusted, the contour is drawn in absolute speaker-
 * relative coordinates so register errors are visible.
 */
export function render (canvas, target, features) {
  const { ctx, w, h } = setupCanvas(canvas);
  ctx.clearRect(0, 0, w, h);
  drawAxes(ctx, w, h);
  if (target) drawTargetBand(ctx, target.tone, target.coefs, w, h);
  if (features && features.voiced && target) {
    drawLearnerContour(ctx, features.displayTimes, features.displayValues,
      contourShift(features, target.coefs), w, h);
  }
}

/**
 * How far to slide the learner's contour vertically before drawing.
 *
 * Until the speaker reference is trusted, the contour is recentered so the
 * picture is a pure SHAPE comparison — matching what the classifier scores.
 * Pass coefs = null (a neutral-tone syllable, which has no target band) to
 * center on the speaker mean line instead of a band mean.
 */
function contourShift (features, coefs) {
  if (features.registerTrusted) return 0;
  let s = 0;
  let n = 0;
  for (const v of features.displayValues) {
    if (Number.isFinite(v)) { s += v; n++; }
  }
  if (n === 0) return 0;
  return (coefs ? targetMeanFromCoefs(coefs) : 0) - s / n;
}

/** Show only the target band — used while idle, before any recording. */
export function renderTargetOnly (canvas, target) {
  render(canvas, target, null);
}

/* ------------------------------------------------------------------ */
/*  Multi-syllable                                                      */
/* ------------------------------------------------------------------ */

/**
 * Render one small canvas per syllable of a multi-syllable utterance.
 *
 * Deliberately N separate canvases reusing render()'s exact drawing path,
 * rather than one wide canvas with multi-segment x-axis logic: each syllable
 * then keeps the same normalized 0..1 x-axis and fixed semitone y-axis the
 * single-word app already uses, so a syllable in a phrase and the same
 * syllable drilled alone are drawn identically and are visually comparable.
 * It also means there is no new geometry code to get wrong.
 *
 * Canvas ELEMENTS are owned here (created and reused in place) because their
 * count varies per phrase and their DPR sizing already lives in this file;
 * everything else about the per-syllable UI — chips, labels, verdict colors —
 * stays with the caller, which is what keeps this module presentation-free.
 *
 * @param {HTMLElement} container  emptied/reused; gets one <canvas> per entry
 * @param {Array<{tone:number, coefs:number[]|null, features:object|null,
 *   neutral?:boolean}|null>} entries  in syllable order. A neutral entry (or
 *   one with coefs null) draws axes + contour but NO target band — there is
 *   no validated neutral-tone target to aim at (see classifier.js's tone-0
 *   guard), so drawing one would invite the learner to match a guess.
 * @returns {HTMLCanvasElement[]} the canvases, in order, so a caller can
 *   attach its own labels or measure positions.
 */
export function renderUtterance (container, entries) {
  const canvases = ensureCanvases(container, entries.length);
  entries.forEach((e, i) => {
    const canvas = canvases[i];
    if (!e) { render(canvas, null, null); return; }
    const band = (e.neutral || !e.coefs) ? null : { tone: e.tone, coefs: e.coefs };
    if (band) {
      render(canvas, band, e.features);
      return;
    }
    // No band: draw axes and (if we have one) the contour, centered on the
    // speaker mean rather than on a band that doesn't exist.
    const { ctx, w, h } = setupCanvas(canvas);
    ctx.clearRect(0, 0, w, h);
    drawAxes(ctx, w, h);
    if (e.features && e.features.voiced) {
      drawLearnerContour(ctx, e.features.displayTimes, e.features.displayValues,
        contourShift(e.features, null), w, h);
    }
  });
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
