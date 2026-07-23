/*
 * segmentation-eval.mjs — validate segmentSyllables() against real
 * ToneAudio double/phrase recordings (Stage 3's "no automated metric alone
 * is sufficient" cheap first pass, per the plan). Mirrors
 * toneaudio-eval.mjs's shape: this is a diagnostic on segmentation quality,
 * not a tone-accuracy score — full sequence accuracy needs sandhi
 * resolution + per-syllable target alignment, which is out of scope here.
 *
 * Two independent signals per clip, both worth tracking separately:
 *   - method: did segmentSyllables() find enough qualifying peaks to match
 *     the known syllable count ('peaks'), or fall back to an even-duration
 *     split ('even-split')?
 *   - perSpanVoiced: does EACH resulting span independently clear the same
 *     confidence gates a monosyllable clip must clear today (the plan's
 *     "per-segment confidence gate mirroring MIN_VOICED_FRAMES/
 *     MIN_HNR_FOR_SCORING")? A clip can find the right peak COUNT and still
 *     produce a span too short/quiet to score.
 */
import { readFileSync } from 'node:fs';

import { prepUtterance, extractSyllableFeatures, SpeakerNormalizer } from '../../docs/single-word/features.js';
import { segmentSyllables } from '../../docs/single-word/segmentation.js';
import { buildAnalysisScript, parseAnalysisOutput } from '../../docs/single-word/praat-analysis.js';
import { DEFAULT_PRAAT_WASM, quiet } from './corpus-eval.mjs';
import { buildManifest, applyStride } from './toneaudio-eval.mjs';

/** Analyze one clip's segmentation quality. Always returns a record (voiced:false on failure/skip). */
export function analyzeSegmentationClip (praat, item) {
  const rec = { token: item.token, cat: item.cat, nSyl: item.nSyl, speaker: item.speaker, condition: item.condition };
  try {
    const buf = readFileSync(item.path);
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    const sound = quiet(() => praat.readAudio(ab, '/tmp/clip.mp3'));
    if (!sound) return { ...rec, voiced: false, reason: 'load-failed' };

    const analysis = parseAnalysisOutput(quiet(() => praat.run(buildAnalysisScript(sound.id))));
    quiet(() => praat.removeAll());

    const prep = prepUtterance(analysis);
    if (!prep.rawSpan) return { ...rec, voiced: false, reason: 'no-voice' };

    const { spans, method, candidateProminences } = segmentSyllables(analysis.intensity, analysis.pitch, item.nSyl, prep.rawSpan);
    const norm = new SpeakerNormalizer(); // throwaway: only .voiced is read below, not register-dependent
    const perSpanVoiced = spans.map(span => extractSyllableFeatures(prep, span, norm).voiced);

    return { ...rec, voiced: true, method, spanCount: spans.length, perSpanVoiced, candidateProminences };
  } catch (e) {
    quiet(() => { try { praat.removeAll(); } catch { /* ignore */ } });
    return { ...rec, voiced: false, reason: 'error:' + (e && e.message ? e.message.slice(0, 60) : 'unknown') };
  }
}

async function extractSerial (items, log) {
  const { createPraatWasm } = await import(DEFAULT_PRAAT_WASM);
  const praat = await createPraatWasm();
  const records = [];
  for (const item of items) records.push(analyzeSegmentationClip(praat, item));
  log(`extracted ${records.length} records (serial)`);
  return records;
}

async function extractParallel (dir, jobs, log) {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { fork } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const { dirname, join } = await import('node:path');
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const worker = join(__dirname, 'segmentation-worker.mjs');
  const outDir = mkdtempSync(join(tmpdir(), 'seg-eval-'));
  let done = 0;

  const runs = Array.from({ length: jobs }, (_, i) => {
    const out = join(outDir, `shard-${i}.json`);
    const child = fork(worker, [], {
      env: { ...process.env, SHARD_INDEX: String(i), SHARD_COUNT: String(jobs), SHARD_OUT: out, TONEAUDIO_DIR: dir },
      stdio: ['ignore', 'ignore', 'inherit', 'ipc']
    });
    return new Promise((resolve, reject) => {
      child.on('exit', (code) => {
        if (code !== 0) return reject(new Error(`segmentation worker ${i} exited with code ${code}`));
        log(`  worker ${++done}/${jobs} finished`);
        resolve(JSON.parse(readFileSync(out, 'utf8')));
      });
      child.on('error', reject);
    });
  });

  return (await Promise.all(runs)).flat();
}

/** Analyze every non-single clip in the corpus at `dir`. No caching (segmentation-only, cheap relative to the full feature cache). */
export async function extractSegmentationResults (dir, { jobs = 1, log = () => {} } = {}) {
  const manifest = applyStride(buildManifest(dir)).filter(m => m.cat !== 'single');
  log(`${manifest.length} multi-syllable clips (${new Set(manifest.map(m => m.token)).size} distinct tokens)`);
  return jobs > 1 ? extractParallel(dir, jobs, log) : extractSerial(manifest, log);
}
