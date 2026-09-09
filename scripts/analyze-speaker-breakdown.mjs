#!/usr/bin/env node
/*
 * analyze-speaker-breakdown.mjs — per-speaker, per-tone accuracy ranking
 * across BOTH corpora (Tone Perfect + ToneAudio), prompted by the question
 * of whether any speaker's tone realization looks like a non-Beijing/
 * Mainland accent (e.g. Taiwan Guoyu) rather than a plain classifier
 * weakness. See DISCUSSION_REMINDERS.md's "Confirm Jinyue's Mandarin
 * background" and "Ask about Tone Perfect speaker MV1's voice" items —
 * this script is the data those questions are asking about.
 *
 * Tone Perfect: per-speaker recall/overall from the existing LOSO benchmark
 * (corpus-eval.mjs) — held-out, so each speaker's number is genuinely
 * speaker-independent, not just "how this speaker scores under a model
 * partly fit on their own voice".
 *
 * ToneAudio: per-speaker recall/overall on SINGLE-word clips only (double/
 * phrase tokens have no per-syllable ground-truth comparison yet — see
 * evaluate-toneaudio.mjs). Reported both pooled and split by recording
 * condition (Quiet/Noisy), since a large condition gap could masquerade as
 * a speaker effect.
 *
 *   node scripts/analyze-speaker-breakdown.mjs
 *   TONEAUDIO_JOBS=12 node scripts/analyze-speaker-breakdown.mjs   # parallel extraction
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { SPEAKERS, extractCorpusFeatures, runLOSO, recall, resolvePerTone } from './lib/corpus-eval.mjs';
import { resolveToneAudioDir, extractToneAudioFeatures } from './lib/toneaudio-eval.mjs';

const ROOT = join(new URL('.', import.meta.url).pathname, '..');
const TP_DIR = process.env.TONE_PERFECT_DIR || join(ROOT, 'tone_perfect');

function emptyConf () { return { 1: {1:0,2:0,3:0,4:0}, 2: {1:0,2:0,3:0,4:0}, 3: {1:0,2:0,3:0,4:0}, 4: {1:0,2:0,3:0,4:0} }; }

function toneRow (rs, trueOf, predOf) {
  const conf = emptyConf();
  let correct = 0;
  for (const r of rs) { const t = trueOf(r), p = predOf(r); conf[t][p]++; if (p === t) correct++; }
  const tones = [1, 2, 3, 4].map(t => recall(conf, t));
  return { n: rs.length, overall: rs.length ? correct / rs.length : 0, tones };
}

async function toneperfectRows () {
  if (!existsSync(TP_DIR)) { console.log('(Tone Perfect corpus not found at ' + TP_DIR + ', skipping)'); return []; }
  const perTone = resolvePerTone('all');
  const records = await extractCorpusFeatures(TP_DIR, perTone, { jobs: 1, useCache: true, log: m => console.log(`  [tone-perfect] ${m}`) });
  const { perSpeaker } = runLOSO(records);
  return SPEAKERS.map(S => {
    const ps = perSpeaker[S];
    if (!ps || !ps.scored) return null;
    const tones = [1, 2, 3, 4].map(t => recall(ps.conf, t));
    return { corpus: 'Tone Perfect', speaker: S, condition: 'LOSO', n: ps.scored, overall: ps.correct / ps.scored, tones };
  }).filter(Boolean);
}

async function toneaudioRows () {
  const dir = resolveToneAudioDir(process.env.TONEAUDIO_DIR);
  if (!dir) { console.log('(No ToneAudio_* drop found, skipping)'); return { pooled: [], byCondition: [] }; }
  const jobs = Math.max(1, parseInt(process.env.TONEAUDIO_JOBS || '8', 10));
  const records = await extractToneAudioFeatures(dir, { jobs, log: m => console.log(`  [toneaudio] ${m}`) });
  const singles = records.filter(r => r.voiced && r.cat === 'single' && r.tones.length === 1);
  const speakers = [...new Set(singles.map(r => r.speaker))].sort();

  const pooled = speakers.map(sp => {
    const rs = singles.filter(r => r.speaker === sp);
    const row = toneRow(rs, r => r.tones[0], r => r.pred);
    return { corpus: 'ToneAudio', speaker: sp, condition: 'pooled', ...row };
  });

  const byCondition = [];
  for (const sp of speakers) {
    for (const c of [...new Set(singles.filter(r => r.speaker === sp).map(r => r.condition))].sort()) {
      const rs = singles.filter(r => r.speaker === sp && r.condition === c);
      if (!rs.length) continue;
      const row = toneRow(rs, r => r.tones[0], r => r.pred);
      byCondition.push({ corpus: 'ToneAudio', speaker: sp, condition: c, ...row });
    }
  }
  return { pooled, byCondition };
}

function printTable (title, rows) {
  console.log('\n' + '-'.repeat(78));
  console.log(title);
  console.log('-'.repeat(78));
  console.log('rank  corpus         speaker    cond    overall    T1    T2    T3    T4    (n)');
  rows
    .slice()
    .sort((a, b) => b.overall - a.overall)
    .forEach((r, i) => {
      const cells = r.tones.map(t => t == null ? '   -' : (100 * t).toFixed(0).padStart(3) + '%');
      console.log(
        `${String(i + 1).padStart(3)}   ${r.corpus.padEnd(13)} ${r.speaker.padEnd(9)} ${r.condition.padEnd(6)} ` +
        `${(100 * r.overall).toFixed(1).padStart(5)}%   ${cells.join(' ')}   (${r.n})`
      );
    });
}

async function main () {
  console.log('='.repeat(78));
  console.log('Per-speaker, per-tone accuracy — Tone Perfect (LOSO) + ToneAudio (single words)');
  console.log('='.repeat(78));

  const [tp, ta] = await Promise.all([toneperfectRows(), toneaudioRows()]);

  printTable('ALL SPEAKERS, overall+per-tone (both corpora, ToneAudio pooled across conditions)', [...tp, ...ta.pooled]);
  if (ta.byCondition.length) printTable('ToneAudio only, split by recording condition', ta.byCondition);
}

main().catch(err => { console.error(err); process.exit(2); });
