/*
 * audit-sandhi.mjs — sanity-check sandhi.js's resolveSandhi() against the
 * ToneAudio corpus's own human-judged filename annotations before trusting
 * it on new curriculum content (per the plan's Stage 6A).
 *
 * Convention (confirmed against the corpus): in a token like "ni2(3)hao3",
 * the digit immediately after a syllable is the SURFACE (realized) tone;
 * a following "(N)" is the CITATION (dictionary) tone, given only when it
 * differs from the surface tone. A syllable with no digit at all is
 * neutral/light tone (citation and surface both 0) — see pinyin-segment.mjs.
 *
 * For each annotated phrase this reconstructs the full citation-tone
 * sequence (citation = surface for any un-annotated syllable), runs it
 * through resolveSandhi(), and compares the predicted surface sequence
 * against every syllable's actually-written surface digit — not just the
 * one that got a "(N)" annotation. Ambiguous 3+ T3 runs are reported
 * separately, never scored as a pass or fail.
 */
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { PINYIN } from './lib/pinyin-segment.mjs';
import { resolveSandhi } from '../docs/single-word/sandhi.js';

const ROOT = process.env.TONEAUDIO_DIR || join(import.meta.dirname, '..', 'ToneAudio_2026-07-22');
const MAXLEN = 6;

function walk (dir, out = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (e.toLowerCase().endsWith('.mp3')) out.push(p);
  }
  return out;
}

function splitNoDigitRun (letters) {
  const out = [];
  let i = 0;
  while (i < letters.length) {
    let matched = 0;
    for (let L = Math.min(MAXLEN, letters.length - i); L >= 1; L--) {
      if (PINYIN.has(letters.slice(i, i + L))) { matched = L; break; }
    }
    const L = matched || 1;
    out.push(letters.slice(i, i + L));
    i += L;
  }
  return out;
}

/*
 * Bare pinyin+tone+annotation token, take-index/rate-tag/extension stripped.
 * Commas/periods in the source filename mark real word/clause boundaries
 * (e.g. "ni2(3)hao3,kai3wen2.hen3..." = three separate words/clauses run
 * together with no space) — kept as "|" so callers can split on them
 * instead of letting T3-run detection blindly cross a word boundary that
 * was never meant to sandhi. Spaces are a boundary too but not a `|s`one:
 * "hen3gao1xing4ren4shi ni3" is one clause split only by a space.
 */
function bareToken (fname) {
  let s = fname.replace(/\.mp3$/i, '').toLowerCase();
  s = s.replace(/[ǚǔǘǜü]/g, 'v');
  const cut = s.search(/[-_ ]\d{1,2}(?=$|[-_])(-slow|-fast|-casual|-faster)*$/);
  s = cut >= 0 ? s.slice(0, cut) : s;
  return s.replace(/[,.]/g, '|').replace(/[^a-z0-9()|]/g, '');
}

/*
 * Match each maximal run of letters, plus a trailing tone digit / "(N)"
 * annotation when one immediately follows. A letter run can itself contain
 * several syllables with no digit between them (e.g. "shini" = "shi" + "ni",
 * where only "ni" carries the following "3") — splitNoDigitRun() breaks
 * those apart, and only the LAST syllable in the run takes the digit; any
 * earlier ones are neutral/light tone.
 */
function tokenizePhrase (cleaned) {
  const re = /([a-z]+)(?:([1-5])(?:\((\d)\))?)?/g;
  const syllables = [];
  let m;
  while ((m = re.exec(cleaned))) {
    if (!m[1]) continue; // guard against the regex's zero-width match at end of string
    const sylNames = splitNoDigitRun(m[1]);
    sylNames.forEach((pinyin, idx) => {
      const isLast = idx === sylNames.length - 1;
      if (isLast && m[2]) {
        const surface = Number(m[2]);
        const citation = m[3] ? Number(m[3]) : surface;
        syllables.push({ pinyin, citation, surface });
      } else {
        syllables.push({ pinyin, citation: 0, surface: 0 });
      }
    });
  }
  return syllables;
}

const files = walk(ROOT);
const tokens = new Set();
for (const f of files) {
  const tok = bareToken(f.split('/').pop());
  if (tok.includes('(')) tokens.add(tok);
}

console.log(`Found ${tokens.size} distinct annotated phrase(s) under ${ROOT}\n`);

let pass = 0, fail = 0, flaggedClauses = 0;
for (const tok of [...tokens].sort()) {
  console.log(tok.replace(/\|/g, ', '));
  const clauses = tok.split('|');
  for (const clause of clauses) {
    if (!clause) continue;
    const syllables = tokenizePhrase(clause);
    const input = syllables.map(s => ({ tone: s.citation }));
    const { surfaceTones, acceptedTones, flags } = resolveSandhi(input);

    const flaggedIdx = new Set();
    for (const fl of flags) for (let i = fl.start; i <= fl.end; i++) flaggedIdx.add(i);

    // Compare against every ACCEPTED realization, not just the displayed
    // one. A 3-long T3 run's first syllable is legitimately either T3 or T2
    // (see sandhi.js), so the corpus recording one of them is agreement,
    // not a mismatch — checking surfaceTones alone would manufacture a
    // failure here roughly half the time.
    const mismatches = [];
    for (let i = 0; i < syllables.length; i++) {
      if (flaggedIdx.has(i)) continue;
      const ok = (acceptedTones[i] || [surfaceTones[i]]).includes(syllables[i].surface);
      if (!ok) {
        mismatches.push({
          i, pinyin: syllables[i].pinyin,
          predicted: (acceptedTones[i] || [surfaceTones[i]]).map(t => 'T' + t).join(' or '),
          actual: syllables[i].surface
        });
      }
    }

    const label = syllables.map(s => `${s.pinyin}${s.citation}${s.citation !== s.surface ? `->${s.surface}` : ''}`).join(' ');
    if (flags.length) {
      flaggedClauses++;
      console.log(`  FLAGGED  ${label}`);
      for (const fl of flags) {
        console.log(`           ambiguous T3 run [${fl.start}..${fl.end}] (length ${fl.runLength}) — needs manual grouping, not auto-checked`);
      }
    } else if (mismatches.length) {
      fail++;
      console.log(`  MISMATCH ${label}`);
      for (const mm of mismatches) {
        console.log(`           [${mm.i}] ${mm.pinyin}: predicted ${mm.predicted}, corpus says T${mm.actual}`);
      }
    } else {
      pass++;
      console.log(`  OK       ${label}`);
    }
  }
}

console.log(`\n${pass} clause(s) matched, ${fail} mismatched, ${flaggedClauses} flagged for manual review (not auto-checked).`);
if (fail > 0) process.exitCode = 1;
