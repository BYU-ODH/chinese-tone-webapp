#!/usr/bin/env node
/*
 * verify-targets.mjs — guarantee every visual tone band reflects what the
 * classifier accepts.
 *
 * A learner aims at the target band drawn by viz.js. If the classifier wouldn't
 * accept that shape as its tone, we'd be marking a faithful imitation wrong. This
 * script checks:
 *   1. All four canonical FALLBACK shapes are classified as their own tone (in
 *      both register regimes). These are ours to control — a failure is a bug and
 *      exits non-zero.
 *   2. Every corpus-derived target in targets.json. Off-model ones are the ones
 *      getSyllableTargets() silently swaps for the fallback at runtime, so they're
 *      reported (rate + examples), not failed — a high rate is the signal to look at.
 *
 *   node scripts/verify-targets.mjs [targets.json]
 */

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { FALLBACK, bandAcceptedAs } from '../docs/single-word/targets.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const targetsPath = process.argv[2] || join(ROOT, 'docs/single-word/targets.json');

let failures = 0;

// 1. Canonical fallbacks — hard requirement.
console.log('Canonical fallback shapes:');
for (let t = 1; t <= 4; t++) {
  const ok = bandAcceptedAs(t, FALLBACK[t]);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}: fallback T${t} is classified as T${t}`);
  if (!ok) failures++;
}

// 2. Corpus targets — report the substitution rate the runtime will apply.
if (existsSync(targetsPath)) {
  const data = JSON.parse(readFileSync(targetsPath, 'utf8'));
  const syllables = data.syllables || {};
  const total = { 1: 0, 2: 0, 3: 0, 4: 0 };
  const offModel = { 1: 0, 2: 0, 3: 0, 4: 0 };
  const examples = { 1: [], 2: [], 3: [], 4: [] };

  for (const [syl, tones] of Object.entries(syllables)) {
    for (let t = 1; t <= 4; t++) {
      const entry = tones[t];
      if (!entry || !Array.isArray(entry.coefs)) continue;
      total[t]++;
      if (!bandAcceptedAs(t, entry)) {
        offModel[t]++;
        if (examples[t].length < 6) examples[t].push(syl);
      }
    }
  }

  const grandTotal = [1, 2, 3, 4].reduce((s, t) => s + total[t], 0);
  const grandOff = [1, 2, 3, 4].reduce((s, t) => s + offModel[t], 0);
  console.log(`\nCorpus targets in ${targetsPath} (${grandTotal} bands):`);
  console.log('  tone   accepted   off-model→fallback   examples');
  for (let t = 1; t <= 4; t++) {
    const acc = total[t] - offModel[t];
    console.log(`   T${t}   ${String(acc).padStart(4)}/${String(total[t]).padEnd(4)}   ` +
      `${String(offModel[t]).padStart(4)} (${total[t] ? (100 * offModel[t] / total[t]).toFixed(0) : '-'}%)` +
      `           ${examples[t].join(', ')}`);
  }
  console.log(`  overall: ${grandTotal - grandOff}/${grandTotal} accepted ` +
    `(${(100 * grandOff / grandTotal).toFixed(1)}% substituted with canonical fallback)`);
} else {
  console.log(`\n(no targets.json at ${targetsPath} — corpus check skipped; app uses fallbacks)`);
}

console.log(failures === 0 ? '\nAll fallback bands are classifier-accepted.' : `\n${failures} fallback FAILURE(s).`);
process.exit(failures === 0 ? 0 : 1);
