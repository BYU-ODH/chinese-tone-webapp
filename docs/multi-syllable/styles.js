/*
 * Styles for <tone-phrase-trainer>, shipped as a JS string rather than a
 * .css file on purpose: the component is meant to be dropped into other
 * apps (see tone-phrase-trainer.js's header), and a single `import` with no
 * second stylesheet fetch and no relative-path assumptions is what makes
 * that painless. It is injected into the component's shadow root, so none
 * of it can leak out into a host page or be overridden by one.
 *
 * THEMING. Every color reads from a `--tt-*` custom property with a
 * fallback. Custom properties inherit THROUGH the shadow boundary, so a
 * host app themes the component from its own stylesheet without touching
 * this file:
 *
 *   tone-phrase-trainer { --tt-accent: #6d28d9; --tt-radius: 4px; }
 *
 * COLOR CHANNELS — the one rule not to break. The plan flagged a real
 * collision: tone-3's identity color and the "correct" verdict color are
 * the same green (#16a34a), so a naive shared palette would make "this is
 * tone 3" indistinguishable from "you got it right". They are therefore
 * kept in strictly separate channels:
 *
 *   verdict    -> chip BACKGROUND tint + border
 *   tone identity -> chip TEXT color
 *
 * Verdict tints are deliberately pale so tone-colored text stays legible
 * on top of them; a saturated verdict fill would have forced the text to
 * white and collapsed the two channels back into one.
 */

export const COMPONENT_CSS = `
:host {
  display: block;
  font-family: var(--tt-font, -apple-system, "Segoe UI", system-ui, "Helvetica Neue", Arial, sans-serif);
  color: var(--tt-fg, #0f172a);
  --t1: var(--tt-t1, #e23636);
  --t2: var(--tt-t2, #f59e0b);
  --t3: var(--tt-t3, #16a34a);
  --t4: var(--tt-t4, #2563eb);
  --t0: var(--tt-t0, #64748b);
  --good: var(--tt-good, #16a34a);
  --close: var(--tt-close, #f59e0b);
  --bad: var(--tt-bad, #ef4444);
  --uncertain: var(--tt-uncertain, #94a3b8);
  --good-tint: var(--tt-good-tint, #ecfdf5);
  --close-tint: var(--tt-close-tint, #fffbeb);
  --bad-tint: var(--tt-bad-tint, #fef2f2);
  --uncertain-tint: var(--tt-uncertain-tint, #f8fafc);
  --border: var(--tt-border, #e2e8f0);
  --muted: var(--tt-muted, #64748b);
  --surface: var(--tt-surface, #ffffff);
  --radius: var(--tt-radius, 12px);
}

:host([hidden]) { display: none; }

.root {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 1.25rem;
}

.hidden { display: none !important; }

/* ---- phrase header ---- */

.phrase-row {
  display: grid;
  grid-template-columns: auto 1fr auto;
  align-items: center;
  gap: 0.5rem;
}

.phrase-display { text-align: center; }

.hanzi {
  font-size: 2.75rem;
  line-height: 1.15;
  font-weight: 500;
  letter-spacing: 0.05em;
}

.gloss { color: var(--muted); font-size: 0.95rem; margin-top: 0.15rem; }

.note {
  color: var(--muted);
  font-size: 0.85rem;
  margin-top: 0.5rem;
  text-align: center;
  min-height: 1.1rem;
}

.nav-btn {
  background: transparent;
  border: 1px solid var(--border);
  width: 2.5rem;
  height: 2.5rem;
  border-radius: 50%;
  font-size: 1.4rem;
  line-height: 1;
  cursor: pointer;
  color: var(--muted);
}
.nav-btn:hover:not(:disabled) { background: var(--surface); color: var(--tt-fg, #0f172a); }
.nav-btn:disabled { opacity: 0.4; cursor: not-allowed; }

/* ---- calibration ---- */

.calib-banner {
  border: 1px solid var(--border);
  background: var(--uncertain-tint);
  border-radius: 8px;
  padding: 0.7rem 0.9rem;
  margin-bottom: 0.85rem;
  font-size: 0.9rem;
  color: var(--muted);
}
.calib-banner p { margin: 0 0 0.5rem; }
.calib-banner .tones { white-space: nowrap; }
.calib-banner .tones .t1 { color: var(--t1); }
.calib-banner .tones .t2 { color: var(--t2); }
.calib-banner .tones .t3 { color: var(--t3); }
.calib-banner .tones .t4 { color: var(--t4); }
.calib-banner .progress { font-weight: 600; color: inherit; }
.calib-banner .row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
}

/* ---- band legend ---- */

.band-legend {
  margin: 0.15rem 0 0.6rem;
  font-size: 0.8rem;
  color: var(--muted, #64748b);
  text-align: center;
}

/* ---- per-syllable canvases ---- */

.syllable-canvases {
  display: grid;
  grid-template-columns: repeat(var(--syllable-count, 1), 1fr);
  gap: 0.4rem;
  margin: 0.75rem 0 0.5rem;
}

/* Fixed HEIGHT, not an aspect ratio. The y axis is a fixed semitone range
   (viz.js's Y_MIN/Y_MAX), so tying cell height to cell width would make the
   same pitch movement render taller in a 2-syllable phrase than in a
   4-syllable one — the learner would read identical productions as
   different-sized errors. A constant height keeps the vertical scale
   comparable across every phrase length; only the time axis compresses. */
.syllable-canvas {
  width: 100%;
  height: var(--tt-plot-height, 210px);
  display: block;
  background: var(--tt-plot-bg, #fafbfc);
  border: 1px solid var(--border);
  border-radius: 8px;
}

/* ---- per-syllable chips ---- */
/* Grid template matches .syllable-canvases exactly so every chip sits
   directly under the contour it describes. */

.syllable-row {
  display: grid;
  grid-template-columns: repeat(var(--syllable-count, 1), 1fr);
  gap: 0.4rem;
}

.chip {
  border: 2px solid var(--border);
  border-radius: 8px;
  padding: 0.4rem 0.25rem;
  text-align: center;
  background: var(--uncertain-tint);
  min-height: 3.4rem;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 0.1rem;
}

/* Verdict -> background tint + border. Never text color. */
.chip.good { background: var(--good-tint); border-color: var(--good); }
.chip.close { background: var(--close-tint); border-color: var(--close); }
.chip.bad { background: var(--bad-tint); border-color: var(--bad); }
.chip.uncertain { background: var(--uncertain-tint); border-color: var(--uncertain); }
.chip.neutral { background: transparent; border-style: dashed; border-color: var(--border); }
.chip.idle { background: transparent; }

/* Tone identity -> text color. Never background. */
.chip .pinyin {
  font-size: 1.15rem;
  font-weight: 600;
  font-feature-settings: "liga" off;
}
.chip .pinyin.t1 { color: var(--t1); }
.chip .pinyin.t2 { color: var(--t2); }
.chip .pinyin.t3 { color: var(--t3); }
.chip .pinyin.t4 { color: var(--t4); }
.chip .pinyin.t0 { color: var(--t0); font-style: italic; font-weight: 500; }

/* Citation form, shown struck through only when sandhi moved the tone. */
.chip .citation {
  font-size: 0.72rem;
  color: var(--muted);
  text-decoration: line-through;
}

.chip .mark { font-size: 0.78rem; color: var(--muted); }

/* Optional-realization hint (both forms are correct). Muted and italic so
   it reads as "also fine", not as a second thing to produce. */
.chip .alt {
  font-size: 0.72rem;
  color: var(--muted);
  font-style: italic;
}

/* ---- controls ---- */

.controls {
  display: flex;
  gap: 0.5rem;
  align-items: center;
  flex-wrap: wrap;
  margin-top: 1rem;
}

.record-btn {
  flex: 1 1 auto;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.6rem;
  padding: 1rem 1.25rem;
  font-size: 1.05rem;
  font-weight: 600;
  background: var(--tt-accent, #0f172a);
  color: white;
  border: none;
  border-radius: 10px;
  cursor: pointer;
  user-select: none;
  -webkit-user-select: none;
  touch-action: none;
  min-height: 56px;
}
.record-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.record-btn.recording { background: var(--bad); }

.record-btn .dot {
  width: 0.9rem;
  height: 0.9rem;
  border-radius: 50%;
  background: #ef4444;
  display: inline-block;
}
.record-btn.recording .dot { animation: tt-pulse 0.9s ease-in-out infinite; }
@keyframes tt-pulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.4; transform: scale(1.25); }
}

.ghost-btn {
  background: transparent;
  border: 1px solid var(--border);
  color: inherit;
  padding: 0.6rem 0.9rem;
  border-radius: 8px;
  cursor: pointer;
  font-size: 0.95rem;
}
.ghost-btn:disabled { opacity: 0.5; cursor: not-allowed; }

/* Play + download travel together; the pair must wrap as a unit, or a narrow
   screen strands a bare icon on the next line with nothing to label it. */
.btn-pair {
  display: inline-flex;
  align-items: stretch;
  gap: 0.25rem;
}
.icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  border: 1px solid var(--border);
  color: inherit;
  padding: 0 0.55rem;
  border-radius: 8px;
  cursor: pointer;
  line-height: 0;
}
.icon-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.icon-btn:hover:not(:disabled) { background: var(--border); }

.mic-meter {
  height: 6px;
  background: var(--border);
  border-radius: 3px;
  margin-top: 0.75rem;
  overflow: hidden;
}
.mic-meter > div {
  height: 100%;
  width: 0;
  background: linear-gradient(to right, #22c55e, #f59e0b, #ef4444);
  transition: width 60ms linear;
}

/* ---- summary / status ---- */

.summary { margin-top: 0.9rem; min-height: 1.4rem; font-size: 0.95rem; }
.summary .diagnostic { color: var(--muted); margin-top: 0.3rem; }

/* Segmentation fell back to an even split: the boundaries are a best guess,
   which must be visible as such rather than presented as exact. */
.warn {
  margin-top: 0.5rem;
  font-size: 0.85rem;
  color: #92400e;
  background: var(--close-tint);
  border: 1px solid var(--close);
  border-radius: 6px;
  padding: 0.4rem 0.6rem;
}

.status-row {
  display: flex;
  justify-content: space-between;
  gap: 0.5rem;
  margin-top: 0.75rem;
  font-size: 0.78rem;
  color: var(--muted);
}

.error {
  margin-top: 0.75rem;
  border: 1px solid #fecaca;
  background: #fef2f2;
  border-radius: 8px;
  padding: 0.6rem 0.8rem;
  font-size: 0.9rem;
}

@media (max-width: 480px) {
  .hanzi { font-size: 2.1rem; }
  .chip .pinyin { font-size: 1rem; }
  .syllable-canvas { height: var(--tt-plot-height, 150px); }
}
`;
