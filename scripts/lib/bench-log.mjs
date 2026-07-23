/*
 * bench-log.mjs — structured, git-tracked history of evaluation runs.
 *
 * Every benchmark run (Tone Perfect LOSO, ToneAudio real-recording eval)
 * appends one snapshot to results/history.json so a pipeline change's effect
 * is a diffable fact, not a number someone half-remembers from a chat. Only
 * aggregate metrics are stored — no audio, no per-clip transcripts, nothing
 * that traces back to a named individual's recording — so this file is safe
 * to commit even though its source corpora (tone_perfect and the dated
 * ToneAudio recording drops) are gitignored research/personal data.
 *
 * Schema (array of run records, newest last):
 *   {
 *     timestamp,            // ISO string
 *     label,                // short human tag, e.g. "octave-fix"
 *     gitCommit, gitDirty,  // provenance: what code produced this number
 *     corpus,               // 'tone-perfect' | 'toneaudio-single' | 'toneaudio-double' | 'toneaudio-phrase'
 *     featureCacheVersion,  // ties the run to the exact acoustic pipeline
 *     sampleSize,           // { scored, skipped, total }
 *     overall,              // { correct, total, pct }
 *     perTone,              // { 1: pct|null, 2: ..., 3: ..., 4: ... } (recall)
 *     perSpeaker,           // optional: { SPEAKER: { correct, total, pct } }
 *     notes                 // free text
 *   }
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const HISTORY_PATH = join(__dirname, '..', 'results', 'history.json');

export function gitInfo () {
  try {
    const commit = execSync('git rev-parse --short HEAD', { cwd: join(__dirname, '..', '..') })
      .toString().trim();
    const dirty = execSync('git status --porcelain=v1 -- . ":!ToneAudio_*"', { cwd: join(__dirname, '..', '..') })
      .toString().trim().length > 0;
    return { gitCommit: commit, gitDirty: dirty };
  } catch {
    return { gitCommit: null, gitDirty: null };
  }
}

export function loadHistory () {
  if (!existsSync(HISTORY_PATH)) return [];
  return JSON.parse(readFileSync(HISTORY_PATH, 'utf8'));
}

/** Append one run record (timestamp + git provenance filled in automatically). */
export function appendRun (entry) {
  const history = loadHistory();
  const record = {
    timestamp: new Date().toISOString(),
    ...gitInfo(),
    ...entry
  };
  history.push(record);
  mkdirSync(dirname(HISTORY_PATH), { recursive: true });
  writeFileSync(HISTORY_PATH, JSON.stringify(history, null, 2) + '\n');
  return record;
}

/** Print the last N runs for a given corpus as a compact comparison table. */
export function printComparison (corpus, n = 6) {
  const runs = loadHistory().filter(r => r.corpus === corpus).slice(-n);
  if (runs.length === 0) { console.log(`(no history for ${corpus})`); return; }
  console.log(`\n${'='.repeat(78)}`);
  console.log(`History: ${corpus} (last ${runs.length})`);
  console.log('='.repeat(78));
  console.log('label'.padEnd(28) + 'commit'.padEnd(10) + 'overall'.padEnd(12) +
    'T1'.padEnd(7) + 'T2'.padEnd(7) + 'T3'.padEnd(7) + 'T4'.padEnd(7) + 'when');
  for (const r of runs) {
    const pct = x => x == null ? '  -  ' : (100 * x).toFixed(0) + '%';
    const ov = r.overall ? `${(100 * r.overall.pct).toFixed(1)}%` : '-';
    const label = (r.label || '').slice(0, 26).padEnd(28);
    const commit = (r.gitCommit || '-').padEnd(9) + (r.gitDirty ? '*' : ' ');
    const pt = r.perTone || {};
    console.log(
      label + commit.padEnd(10) + ov.padEnd(12) +
      pct(pt[1]).padEnd(7) + pct(pt[2]).padEnd(7) + pct(pt[3]).padEnd(7) + pct(pt[4]).padEnd(7) +
      r.timestamp.slice(0, 10)
    );
  }
  console.log('(* = uncommitted changes present when the run was made)');
}
