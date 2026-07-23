/*
 * Regression test for segmentSyllables() (docs/single-word/segmentation.js).
 *
 * No Praat/WASM needed: segmentSyllables() consumes plain {n,dx,x1,values}
 * blocks, so we synthesize intensity/pitch contours directly, the same way
 * test_normalizer.mjs synthesizes analysis structs.
 *
 * Run from the project root:
 *   node test_segmentation.mjs
 */

import { segmentSyllables } from './docs/single-word/segmentation.js';

const DX = 0.01; // 10ms frames

function block (values, dx = DX, x1 = dx / 2) {
  return { n: values.length, dx, x1, values };
}

/** A triangular intensity hump: baseVal outside [center-halfWidth, center+halfWidth]. */
function hump (n, center, halfWidth, peakVal, baseVal) {
  const out = new Array(n).fill(baseVal);
  for (let i = 0; i < n; i++) {
    const d = Math.abs(i - center);
    if (d <= halfWidth) out[i] = baseVal + (peakVal - baseVal) * (1 - d / halfWidth);
  }
  return out;
}

/** Envelope of several humps (pointwise max) over a shared baseline. */
function combine (n, baseVal, ...humps) {
  const out = new Array(n).fill(baseVal);
  for (const h of humps) for (let i = 0; i < n; i++) out[i] = Math.max(out[i], h[i]);
  return out;
}

/** Pitch contour: `hz` inside each [lo,hi] range (inclusive), NaN elsewhere. */
function pitchWithVoicedRanges (n, ranges, hz = 200) {
  const out = new Array(n).fill(NaN);
  for (const [lo, hi] of ranges) for (let i = lo; i <= hi && i < n; i++) out[i] = hz;
  return out;
}

let failures = 0;
function check (cond, label) {
  if (cond) {
    console.log(`  PASS: ${label}`);
  } else {
    failures++;
    console.log(`  FAIL: ${label}`);
  }
}

function checkCoverage (spans, start, end, label) {
  const gaplessContiguous = spans.every((s, i) => i === 0 || s.start === spans[i - 1].end + 1);
  check(spans[0]?.start === start && spans[spans.length - 1]?.end === end && gaplessContiguous,
    `${label}: spans cover [${start},${end}] with no gaps/overlaps (got ${JSON.stringify(spans)})`);
}

/* ------------------------------------------------------------------ */

console.log('--- 1. Two clear syllables, deep dip between: peak-based split ---');
{
  const n = 60;
  const intensity = block(combine(n, 40, hump(n, 10, 8, 80, 40), hump(n, 40, 8, 80, 40)));
  const pitch = block(pitchWithVoicedRanges(n, [[2, 18], [32, 48]]));
  const { spans, method } = segmentSyllables(intensity, pitch, 2, { start: 0, end: n - 1 });

  check(method === 'peaks', `method is 'peaks' (got '${method}')`);
  check(spans.length === 2, `2 spans returned (got ${spans.length})`);
  checkCoverage(spans, 0, n - 1, 'two-syllable');
  check(spans[0].end >= 18 && spans[0].end <= 32 && spans[1].start === spans[0].end + 1,
    `boundary falls in the dip between the humps (got boundary at ${spans[0].end}/${spans[1].start})`);
}

console.log('\n--- 2. Three clear syllables: peak-based split, correct order ---');
{
  const n = 90;
  const intensity = block(combine(n, 40,
    hump(n, 10, 7, 78, 40), hump(n, 45, 7, 82, 40), hump(n, 78, 7, 75, 40)));
  const pitch = block(pitchWithVoicedRanges(n, [[3, 17], [38, 52], [71, 85]]));
  const { spans, method } = segmentSyllables(intensity, pitch, 3, { start: 0, end: n - 1 });

  check(method === 'peaks', `method is 'peaks' (got '${method}')`);
  check(spans.length === 3, `3 spans returned (got ${spans.length})`);
  checkCoverage(spans, 0, n - 1, 'three-syllable');
  check(spans[0].end < spans[1].start === false || spans[0].end + 1 === spans[1].start,
    'span 1/2 boundary is contiguous');
  // Each syllable's own peak should land inside its own span.
  check(spans[0].start <= 10 && 10 <= spans[0].end, 'peak 1 (frame 10) inside span 0');
  check(spans[1].start <= 45 && 45 <= spans[1].end, 'peak 2 (frame 45) inside span 1');
  check(spans[2].start <= 78 && 78 <= spans[2].end, 'peak 3 (frame 78) inside span 2');
}

console.log('\n--- 3. Middle syllable unvoiced (unrecoverable merge): falls back to even-split ---');
{
  // Three intensity humps, but the middle one has NO voiced pitch nearby
  // (e.g. a whispered/devoiced syllable) — segmentSyllables must not
  // invent a boundary it can't voicing-confirm; it should say so via the
  // even-split fallback rather than guess.
  const n = 90;
  const intensity = block(combine(n, 40,
    hump(n, 10, 7, 78, 40), hump(n, 45, 7, 82, 40), hump(n, 78, 7, 75, 40)));
  const pitch = block(pitchWithVoicedRanges(n, [[3, 17], [71, 85]])); // middle hump left unvoiced
  const { spans, method } = segmentSyllables(intensity, pitch, 3, { start: 0, end: n - 1 });

  check(method === 'even-split', `method is 'even-split' (got '${method}')`);
  check(spans.length === 3, `3 spans returned (got ${spans.length})`);
  checkCoverage(spans, 0, n - 1, 'unvoiced-middle fallback');
}

console.log('\n--- 4. A louder unvoiced noise burst must not steal a slot from a real, quieter syllable ---');
{
  // Two real (voiced) syllables plus one louder but unvoiced noise burst
  // between them. targetCount=2 must select the two REAL syllables, not
  // the burst, even though the burst is the most prominent peak by dB.
  const n = 90;
  const intensity = block(combine(n, 40,
    hump(n, 10, 7, 70, 40),   // real syllable 1 (quieter)
    hump(n, 45, 5, 95, 40),   // noise burst (louder, unvoiced)
    hump(n, 78, 7, 70, 40)));  // real syllable 2 (quieter)
  const pitch = block(pitchWithVoicedRanges(n, [[3, 17], [71, 85]])); // burst at 45 is NOT voiced
  const { spans, method } = segmentSyllables(intensity, pitch, 2, { start: 0, end: n - 1 });

  check(method === 'peaks', `method is 'peaks' (got '${method}')`);
  check(spans.length === 2, `2 spans returned (got ${spans.length})`);
  checkCoverage(spans, 0, n - 1, 'noise-burst-rejection');
  check(spans[0].start <= 10 && 10 <= spans[0].end, 'real syllable 1 (frame 10) inside span 0');
  check(spans[1].start <= 78 && 78 <= spans[1].end, 'real syllable 2 (frame 78) inside span 1');
}

console.log('\n--- 5. A flat silent stretch must not pad the peak count past targetCount ---');
{
  // One real syllable followed by a long flat near-silent stretch. Every
  // frame in a flat run is trivially a "local max" (>= both neighbors) —
  // without a minimum-prominence floor this could masquerade as extra
  // syllable candidates. targetCount=2 with only 1 real peak must fall
  // back to even-split, not carve the flat silence into a fake syllable.
  const n = 60;
  const intensity = block(combine(n, 40, hump(n, 10, 8, 80, 40))); // frames 19..60 are flat baseline
  const pitch = block(pitchWithVoicedRanges(n, [[2, 18]]));
  const { spans, method } = segmentSyllables(intensity, pitch, 2, { start: 0, end: n - 1 });

  check(method === 'even-split', `method is 'even-split' (got '${method}'); flat baseline did not fake a second peak`);
  check(spans.length === 2, `2 spans returned (got ${spans.length})`);
  checkCoverage(spans, 0, n - 1, 'flat-baseline no-pad');
}

console.log('\n--- 6. targetCount=1 is a no-op (whole span, one span) ---');
{
  const n = 40;
  const intensity = block(combine(n, 40, hump(n, 20, 10, 80, 40)));
  const pitch = block(pitchWithVoicedRanges(n, [[10, 30]]));
  const { spans, method } = segmentSyllables(intensity, pitch, 1, { start: 0, end: n - 1 });

  check(method === 'peaks', `method is 'peaks' (got '${method}')`);
  check(spans.length === 1 && spans[0].start === 0 && spans[0].end === n - 1,
    `single span covers the whole clip (got ${JSON.stringify(spans)})`);
}

/* ------------------------------------------------------------------ */

console.log('\n' + '='.repeat(40));
console.log(failures === 0 ? 'All checks passed.' : `${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
