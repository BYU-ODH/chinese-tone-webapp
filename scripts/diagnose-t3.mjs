#!/usr/bin/env node
/*
 * diagnose-t3.mjs — investigate the speaker-dependent T3 collapse using the
 * cached full-corpus features (.tone-cache/features-all-v1.json). No Praat: it
 * re-scores each cached record with the live classifier and dissects T3.
 *
 * The T3 template is essentially "is there positive curvature (a dip)?":
 *   T3 shape score = rampUp(c2, 1, 3.5)*1.0 + bell(c1, -1, 3)*0.3   (register off here)
 * so a T3 with c2 < 1 gets ZERO curvature credit and loses to whichever of
 * T1 (flat: c1≈0,c2≈0) / T2 (c1>0) / T4 (c1<<0) its contour resembles.
 *
 *   node scripts/diagnose-t3.mjs
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { classify } from '../docs/single-word/classifier.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const cache = JSON.parse(readFileSync(join(ROOT, '.tone-cache', 'features-all-v1.json'), 'utf8'));
const records = cache.records.filter(r => r.voiced);

const SPEAKERS = ['FV1', 'FV2', 'FV3', 'MV1', 'MV2', 'MV3'];

function quantiles (arr) {
  if (!arr.length) return { p25: NaN, p50: NaN, p75: NaN };
  const s = [...arr].sort((a, b) => a - b);
  const q = p => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return { p25: q(0.25), p50: q(0.5), p75: q(0.75) };
}
const f2 = x => (Number.isFinite(x) ? x.toFixed(2).padStart(6) : '     -');
const pct = (n, d) => (d ? (100 * n / d).toFixed(0) + '%' : '-');

/* ---- 1. Per-speaker T3 confusion: where do T3 clips go? ---- */
console.log('='.repeat(70));
console.log('T3 clips by speaker — where they land (row-normalised)');
console.log('='.repeat(70));
console.log('  spk    n   →T1   →T2   →T3✓  →T4    | c2<1 (no dip credit)');
for (const S of SPEAKERS) {
  const t3 = records.filter(r => r.speaker === S && r.tone === 3);
  const dest = { 1: 0, 2: 0, 3: 0, 4: 0 };
  let lowC2 = 0;
  for (const r of t3) {
    dest[classify(3, r).bestTone]++;
    if (r.coefs[2] < 1) lowC2++;
  }
  const n = t3.length;
  console.log(`  ${S}  ${String(n).padStart(4)}  ` +
    `${pct(dest[1], n).padStart(4)}  ${pct(dest[2], n).padStart(4)}  ` +
    `${pct(dest[3], n).padStart(4)}  ${pct(dest[4], n).padStart(4)}    | ${pct(lowC2, n)}`);
}

/* ---- 2. c2 (dip curvature) distribution: correct vs missed T3 ---- */
console.log('\n' + '='.repeat(70));
console.log('c2 (dip curvature) — the decisive feature — median [p25..p75]');
console.log('T3 needs c2 >= 1 for any shape credit.');
console.log('='.repeat(70));
console.log('  spk      correct T3 c2        missed T3 c2       (correct / total)');
for (const S of SPEAKERS) {
  const t3 = records.filter(r => r.speaker === S && r.tone === 3);
  const ok = t3.filter(r => classify(3, r).bestTone === 3).map(r => r.coefs[2]);
  const bad = t3.filter(r => classify(3, r).bestTone !== 3).map(r => r.coefs[2]);
  const qo = quantiles(ok), qb = quantiles(bad);
  console.log(`  ${S}   ${f2(qo.p50)} [${f2(qo.p25)}..${f2(qo.p75)}]   ` +
    `${f2(qb.p50)} [${f2(qb.p25)}..${f2(qb.p75)}]    (${ok.length}/${t3.length})`);
}

/* ---- 3. c1 (slope) of missed T3, split by where it went ---- */
console.log('\n' + '='.repeat(70));
console.log('Missed T3 — c1 (slope) & c2 by destination tone (all speakers pooled)');
console.log('T3→T1: flat/shallow (c1≈0,c2 low) · T3→T4: falls (c1<0) · T3→T2: rises (c1>0)');
console.log('='.repeat(70));
const t3all = records.filter(r => r.tone === 3);
console.log('  dest     n     c1 median [p25..p75]      c2 median [p25..p75]');
for (const dest of [1, 2, 4]) {
  const grp = t3all.filter(r => classify(3, r).bestTone === dest);
  const c1 = quantiles(grp.map(r => r.coefs[1]));
  const c2 = quantiles(grp.map(r => r.coefs[2]));
  console.log(`  →T${dest}  ${String(grp.length).padStart(5)}   ` +
    `${f2(c1.p50)} [${f2(c1.p25)}..${f2(c1.p75)}]      ${f2(c2.p50)} [${f2(c2.p25)}..${f2(c2.p75)}]`);
}
const okAll = t3all.filter(r => classify(3, r).bestTone === 3);
const c1ok = quantiles(okAll.map(r => r.coefs[1]));
const c2ok = quantiles(okAll.map(r => r.coefs[2]));
console.log(`  →T3✓ ${String(okAll.length).padStart(5)}   ` +
  `${f2(c1ok.p50)} [${f2(c1ok.p25)}..${f2(c1ok.p75)}]      ${f2(c2ok.p50)} [${f2(c2ok.p25)}..${f2(c2ok.p75)}]`);

/* ---- 4. c0 (register) — is the dip low? (informational; register is OFF in this regime) ---- */
console.log('\n' + '='.repeat(70));
console.log('c0 (register, semitones re speaker mean) — good vs bad T3 speakers');
console.log('Register cues are OFF here (fresh normalizer), but shows if T3 sits low.');
console.log('='.repeat(70));
for (const S of SPEAKERS) {
  const t3 = records.filter(r => r.speaker === S && r.tone === 3);
  const q = quantiles(t3.map(r => r.coefs[0]));
  console.log(`  ${S}   c0 ${f2(q.p50)} [${f2(q.p25)}..${f2(q.p75)}]`);
}

/* ---- 5. Could register/onset rescue the confusions? Compare the confused ---- */
/*         T3 against the GENUINE tone it was mistaken for, on c0 (register) and */
/*         onset (start height). If they separate, a register/onset cue fixes it. */
console.log('\n' + '='.repeat(70));
console.log('Would register/onset separate the confusion? (c0 & onset medians)');
console.log('Register cues are OFF in this eval — this tests whether turning them ON helps.');
console.log('='.repeat(70));
const genuine = t => records.filter(r => r.tone === t && classify(t, r).bestTone === t);
const confusedT3 = dest => t3all.filter(r => classify(3, r).bestTone === dest);
const line = (label, grp) => {
  const c0 = quantiles(grp.map(r => r.coefs[0]));
  const on = quantiles(grp.map(r => r.onset));
  const off = quantiles(grp.map(r => r.offset));
  const dur = quantiles(grp.map(r => r.voicedFrameCount)); // 5 ms/frame → duration proxy
  console.log(`  ${label.padEnd(22)} n=${String(grp.length).padStart(4)}  ` +
    `c0 ${f2(c0.p50)}  onset ${f2(on.p50)}  offset ${f2(off.p50)}  ` +
    `voiFrames ${f2(dur.p50)}`);
};
line('T3 misread as T1', confusedT3(1));
line('  genuine T1', genuine(1));
line('T3 misread as T4', confusedT3(4));
line('  genuine T4', genuine(4));
line('T3 correct', okAll);
