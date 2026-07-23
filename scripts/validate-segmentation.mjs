/*
 * validate-segmentation.mjs — Stage 3's first real-data check: does
 * segmentSyllables() find the right number of syllable peaks on genuine
 * multi-syllable recordings, and does each resulting span independently
 * clear the same confidence gates a monosyllable clip must clear today?
 *
 * This is a segmentation diagnostic, not a tone-accuracy score (see
 * segmentation-eval.mjs's header) — de Jong & Wempe's thresholds were
 * fit on Dutch, and this is exactly the "needs Mandarin-specific
 * validation" check the plan flagged rather than assuming.
 *
 * Usage:
 *   node scripts/validate-segmentation.mjs
 *   SEG_JOBS=14 node scripts/validate-segmentation.mjs   # parallel
 *   TONEAUDIO_STRIDE=4 node scripts/validate-segmentation.mjs  # smoke test
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { resolveToneAudioDir } from './lib/toneaudio-eval.mjs';
import { extractSegmentationResults } from './lib/segmentation-eval.mjs';
import { gitInfo } from './lib/bench-log.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HISTORY_PATH = join(__dirname, 'results', 'segmentation-history.json');

function log (msg) { console.log(msg); }

function pct (n, d) { return d ? +(100 * n / d).toFixed(1) : null; }
function pctStr (n, d) { const p = pct(n, d); return p == null ? '-' : `${p}%`; }

function groupBy (arr, fn) {
  const out = {};
  for (const x of arr) { const k = fn(x); (out[k] ||= []).push(x); }
  return out;
}

function mean (xs) { return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null; }

/** Both the console line and the structured summary object for one row group. */
function summaryStats (rows) {
  const voiced = rows.filter(r => r.voiced);
  const peaks = voiced.filter(r => r.method === 'peaks');
  const evenSplit = voiced.filter(r => r.method === 'even-split');
  const allScorable = voiced.filter(r => r.perSpanVoiced && r.perSpanVoiced.every(Boolean));
  // Lombard-effect diagnostic: does the STRONGEST candidate syllable-boundary
  // dip (regardless of whether targetCount was met) tend to be deeper in one
  // group than another, and are there more candidates overall? A real
  // hyperarticulation effect should show up as both higher topProminence
  // and higher candidateCount, not just one.
  const withCandidates = voiced.filter(r => r.candidateProminences && r.candidateProminences.length);
  const topProminences = withCandidates.map(r => r.candidateProminences[0]);
  const candidateCounts = voiced.map(r => (r.candidateProminences || []).length);
  return {
    total: rows.length, voiced: voiced.length,
    peaks: peaks.length, evenSplit: evenSplit.length, allSpansScorable: allScorable.length,
    voicedPct: pct(voiced.length, rows.length),
    peaksPct: pct(peaks.length, voiced.length),
    evenSplitPct: pct(evenSplit.length, voiced.length),
    allSpansScorablePct: pct(allScorable.length, voiced.length),
    meanTopProminenceDb: round1(mean(topProminences)),
    meanCandidateCount: round1(mean(candidateCounts))
  };
}

function round1 (x) { return x == null ? null : +x.toFixed(1); }

function printSummary (s, indent = '  ') {
  console.log(`${indent}voiced ${s.voiced}/${s.total} (${pctStr(s.voiced, s.total)})  ` +
    `peaks ${s.peaks} (${s.peaksPct == null ? '-' : s.peaksPct + '%'})  ` +
    `even-split ${s.evenSplit} (${s.evenSplitPct == null ? '-' : s.evenSplitPct + '%'})  ` +
    `all-spans-scorable ${s.allSpansScorable} (${s.allSpansScorablePct == null ? '-' : s.allSpansScorablePct + '%'})`);
  console.log(`${indent}mean top candidate prominence: ${s.meanTopProminenceDb == null ? '-' : s.meanTopProminenceDb + 'dB'}  ` +
    `mean candidate count: ${s.meanCandidateCount == null ? '-' : s.meanCandidateCount}`);
}

function report (records) {
  const byCat = groupBy(records, r => r.cat);
  const summary = {};
  for (const cat of ['double', 'phrase']) {
    const rows = byCat[cat] || [];
    if (rows.length === 0) continue;
    console.log(`\n${'='.repeat(64)}\n${cat.toUpperCase()} — ${rows.length} clips\n${'='.repeat(64)}`);
    const overall = summaryStats(rows);
    printSummary(overall);

    const bySpeakerCondition = {};
    const byGroup = groupBy(rows, r => `${r.speaker}/${r.condition}`);
    for (const [key, sub] of Object.entries(byGroup).sort()) {
      console.log(`  ${key} (${sub.length}):`);
      const s = summaryStats(sub);
      printSummary(s, '    ');
      bySpeakerCondition[key] = s;
    }

    const reasons = groupBy(rows.filter(r => !r.voiced), r => r.reason);
    if (Object.keys(reasons).length) {
      console.log('  Unvoiced/skipped breakdown:');
      for (const [reason, sub] of Object.entries(reasons)) console.log(`    ${reason}: ${sub.length}`);
    }

    summary[cat] = { overall, bySpeakerCondition };
  }
  return summary;
}

function appendHistory (entry) {
  const history = existsSync(HISTORY_PATH) ? JSON.parse(readFileSync(HISTORY_PATH, 'utf8')) : [];
  history.push({ timestamp: new Date().toISOString(), ...gitInfo(), ...entry });
  mkdirSync(dirname(HISTORY_PATH), { recursive: true });
  writeFileSync(HISTORY_PATH, JSON.stringify(history, null, 2) + '\n');
  console.log(`\nAppended to ${HISTORY_PATH}`);
}

async function main () {
  const dir = resolveToneAudioDir(process.env.TONEAUDIO_DIR);
  if (!dir) {
    console.error('No ToneAudio_* corpus directory found next to the repo root.');
    process.exit(1);
  }
  const jobs = parseInt(process.env.SEG_JOBS || '1', 10);
  const label = process.env.SEG_LABEL || null;

  console.log('='.repeat(64));
  console.log('Segmentation validation — real ToneAudio double/phrase clips');
  console.log('='.repeat(64));
  console.log(`Corpus: ${dir} · jobs: ${jobs}`);

  const records = await extractSegmentationResults(dir, { jobs, log });
  const summary = report(records);
  appendHistory({ label, corpus: dir, stride: parseInt(process.env.TONEAUDIO_STRIDE || '1', 10), summary });
}

main().catch(err => { console.error(err); process.exit(2); });
