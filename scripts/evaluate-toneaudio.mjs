#!/usr/bin/env node
/*
 * evaluate-toneaudio.mjs — real-recording evaluation against a ToneAudio
 * drop (dated folder of student/instructor recordings; gitignored personal
 * data, never redistributed).
 *
 * Unlike Tone Perfect, this corpus mixes single words, double words, and
 * phrases (see scripts/lib/pinyin-segment.mjs for how that's detected from
 * the filename). The pipeline is monosyllable-only — one vowel nucleus in,
 * one predicted tone out — so:
 *   - SINGLE words get a real accuracy score: predicted tone vs. ground truth.
 *   - DOUBLE/PHRASE tokens do NOT get a sequence score (there's no per-syllable
 *     segmentation yet). We instead report how often the single predicted tone
 *     coincides with the first/last/any target syllable's tone, against the
 *     chance rate — a measure of what the current pipeline can and can't tell
 *     you about multi-syllable input, not a substitute for real evaluation.
 *
 * Every run appends a structured snapshot per category to
 * scripts/results/history.json (scripts/lib/bench-log.mjs) so accuracy
 * changes across pipeline edits are a diffable fact.
 *
 *   node scripts/evaluate-toneaudio.mjs                          # serial
 *   TONEAUDIO_JOBS=14 node scripts/evaluate-toneaudio.mjs         # parallel
 *   TONEAUDIO_DIR=/path/to/ToneAudio_YYYY-MM-DD node scripts/evaluate-toneaudio.mjs
 *   TONEAUDIO_LABEL="octave-fix" node scripts/evaluate-toneaudio.mjs   # tag the history row
 */
import { existsSync } from 'node:fs';

import { resolveToneAudioDir, extractToneAudioFeatures } from './lib/toneaudio-eval.mjs';
import { appendRun, printComparison } from './lib/bench-log.mjs';
import { FEATURE_CACHE_VERSION } from './lib/corpus-eval.mjs';

const pct = (n, d) => d ? (100 * n / d).toFixed(1) + '%' : '—';

async function main () {
  const dir = resolveToneAudioDir(process.env.TONEAUDIO_DIR);
  if (!dir || !existsSync(dir)) {
    console.error('No ToneAudio_* directory found (and TONEAUDIO_DIR not set).');
    console.error('This is gitignored personal recording data — place a drop at the repo root or set TONEAUDIO_DIR.');
    process.exit(1);
  }
  console.log('='.repeat(64));
  console.log('ToneAudio — real-recording evaluation');
  console.log('='.repeat(64));
  console.log(`Corpus: ${dir}`);

  await run(dir);
}

async function run (dir) {
  const jobs = Math.max(1, parseInt(process.env.TONEAUDIO_JOBS || '1', 10));
  const label = process.env.TONEAUDIO_LABEL || 'unlabeled run';

  const t0 = Date.now();
  const records = await extractToneAudioFeatures(dir, { jobs, log: m => console.log(`  ${m}`) });
  console.log(`Extracted ${records.length} records in ${((Date.now() - t0) / 60000).toFixed(1)} min.\n`);

  const byCat = { single: [], double: [], phrase: [] };
  for (const r of records) byCat[r.cat].push(r);

  reportSingle(byCat.single, label);
  reportCollapse('double', byCat.double, label);
  reportCollapse('phrase', byCat.phrase, label);

  for (const c of ['toneaudio-single', 'toneaudio-double', 'toneaudio-phrase']) printComparison(c);
}

function reportSingle (rs0, label) {
  console.log('\n' + '='.repeat(64));
  console.log(`SINGLE WORDS — ${rs0.length} clips`);
  console.log('='.repeat(64));

  const skipped = rs0.filter(r => !r.voiced);
  const rs = rs0.filter(r => r.voiced && r.tones.length === 1);
  const conf = { 1: {1:0,2:0,3:0,4:0}, 2: {1:0,2:0,3:0,4:0}, 3: {1:0,2:0,3:0,4:0}, 4: {1:0,2:0,3:0,4:0} };
  let correct = 0;
  for (const r of rs) { conf[r.tones[0]][r.pred]++; if (r.pred === r.tones[0]) correct++; }

  console.log(`Voiced/scorable: ${rs.length}/${rs0.length}  skipped: ${skipped.length}`);
  console.log(`Overall accuracy: ${correct}/${rs.length} = ${pct(correct, rs.length)}\n`);
  console.log('        T1    T2    T3    T4   | recall');
  const perTone = {};
  for (const t of [1,2,3,4]) {
    const row = conf[t]; const tot = row[1]+row[2]+row[3]+row[4];
    perTone[t] = tot ? row[t] / tot : null;
    console.log(`   T${t} ${String(row[1]).padStart(5)} ${String(row[2]).padStart(5)} ${String(row[3]).padStart(5)} ${String(row[4]).padStart(5)}   | ${tot ? pct(row[t],tot) : '—'}`);
  }

  const perSpeaker = {};
  for (const sp of [...new Set(rs.map(r => r.speaker))].sort()) {
    for (const c of [...new Set(rs.map(r => r.condition))].sort()) {
      const sub = rs.filter(r => r.speaker === sp && r.condition === c);
      if (!sub.length) continue;
      const ok = sub.filter(r => r.pred === r.tones[0]).length;
      perSpeaker[`${sp}-${c}`] = { correct: ok, total: sub.length, pct: ok / sub.length };
      console.log(`  ${sp}/${c}: ${ok}/${sub.length} = ${pct(ok, sub.length)}`);
    }
  }

  appendRun({
    label, corpus: 'toneaudio-single', featureCacheVersion: FEATURE_CACHE_VERSION,
    sampleSize: { scored: rs.length, skipped: skipped.length, total: rs0.length },
    overall: { correct, total: rs.length, pct: rs.length ? correct / rs.length : null },
    perTone, perSpeaker, confusion: conf
  });
}

function reportCollapse (catName, rs0, label) {
  console.log('\n' + '='.repeat(64));
  console.log(`${catName.toUpperCase()} — pipeline still returns ONE tone per clip (no segmentation)`);
  console.log('='.repeat(64));

  const rs = rs0.filter(r => r.voiced && r.tones.length >= 1);
  let matchFirst = 0, matchLast = 0, matchAny = 0, chanceAnySum = 0;
  for (const r of rs) {
    if (r.pred === r.tones[0]) matchFirst++;
    if (r.pred === r.tones[r.tones.length - 1]) matchLast++;
    if (r.tones.includes(r.pred)) matchAny++;
    chanceAnySum += new Set(r.tones.filter(t => t >= 1 && t <= 4)).size / 4;
  }
  const n = rs.length;
  const chanceAny = n ? chanceAnySum / n : null;
  console.log(`Scored ${n}/${rs0.length} voiced clips. The single predicted tone coincides with:`);
  console.log(`  FIRST syllable's tone: ${matchFirst}/${n} = ${pct(matchFirst, n)}  (chance 25%)`);
  console.log(`  LAST  syllable's tone: ${matchLast}/${n} = ${pct(matchLast, n)}  (chance 25%)`);
  console.log(`  ANY   syllable's tone: ${matchAny}/${n} = ${pct(matchAny, n)}  (chance ~${chanceAny != null ? (100*chanceAny).toFixed(0) : '-'}%)`);
  console.log('Per-syllable tone judgments produced: 0 (no segmentation) — sequence accuracy is undefined.');

  appendRun({
    label, corpus: `toneaudio-${catName}`, featureCacheVersion: FEATURE_CACHE_VERSION,
    sampleSize: { scored: n, skipped: rs0.length - n, total: rs0.length },
    overall: null, perTone: null,
    collapse: {
      matchFirst: { n: matchFirst, total: n, pct: n ? matchFirst / n : null },
      matchLast: { n: matchLast, total: n, pct: n ? matchLast / n : null },
      matchAny: { n: matchAny, total: n, pct: n ? matchAny / n : null },
      chanceAny
    },
    notes: 'No per-syllable segmentation yet; this is NOT a sequence-accuracy score.'
  });
}

main().catch(err => { console.error(err); process.exit(2); });
