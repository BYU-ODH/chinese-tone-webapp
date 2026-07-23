/*
 * toneaudio-eval.mjs — shared evaluation machinery for the ToneAudio
 * real-recording drops (dated folders of student/instructor recordings,
 * gitignored personal data). Mirrors corpus-eval.mjs's shape but for a
 * corpus with mixed single/double/phrase tokens instead of Tone Perfect's
 * uniform monosyllables — see pinyin-segment.mjs for the categorization.
 *
 * Every clip — single, double, or phrase — is run through the SAME
 * monosyllable pipeline (it isolates one vowel nucleus and returns one
 * predicted tone; there is no segmentation yet). For single words that
 * predicted tone is directly comparable to ground truth. For double/phrase
 * tokens it is not a sequence prediction — reportToneAudio() in
 * evaluate-toneaudio.mjs quantifies what CAN be said about those (does the
 * one output coincide with the first/last/any target syllable's tone)
 * rather than pretending it's a real multi-syllable score.
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { fork } from 'node:child_process';

import { extractFeatures, SpeakerNormalizer } from '../../docs/single-word/features.js';
import { classify } from '../../docs/single-word/classifier.js';
import { buildAnalysisScript, parseAnalysisOutput } from '../../docs/single-word/praat-analysis.js';
import { buildManifest } from './pinyin-segment.mjs';
import { DEFAULT_PRAAT_WASM, quiet } from './corpus-eval.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Locate the corpus: explicit dir, or the most-recently-modified ToneAudio_* sibling of the repo root. */
export function resolveToneAudioDir (explicit) {
  if (explicit) return explicit;
  const root = join(__dirname, '..', '..');
  const candidates = readdirSync(root)
    .filter(e => /^ToneAudio_/.test(e))
    .map(e => join(root, e))
    .filter(p => existsSync(p));
  if (candidates.length === 0) return null;
  return candidates
    .map(p => ({ p, mtime: statSync(p).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)[0].p;
}

/** Analyze one clip through the real pipeline. Always returns a record (voiced:false on failure/skip). */
export function analyzeToneAudioClip (praat, item) {
  const rec = { token: item.token, cat: item.cat, tones: item.tones,
    speaker: item.speaker, condition: item.condition };
  try {
    const buf = readFileSync(item.path);
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    const sound = quiet(() => praat.readAudio(ab, '/tmp/clip.mp3'));
    if (!sound) return { ...rec, voiced: false, reason: 'load-failed' };

    const analysis = parseAnalysisOutput(quiet(() => praat.run(buildAnalysisScript(sound.id))));
    quiet(() => praat.removeAll());
    const f = extractFeatures(analysis, new SpeakerNormalizer());
    if (!f.voiced) return { ...rec, voiced: false, reason: f.reason };

    const target = item.tones.length ? item.tones[0] : 1;
    const v = classify(target, f);
    return {
      ...rec, voiced: true, pred: v.bestTone,
      coefs: f.coefs.map(c => +c.toFixed(2)),
      voicedFrameCount: f.voicedFrameCount, vowelCoreFrames: f.vowelCoreFrames
    };
  } catch (e) {
    quiet(() => { try { praat.removeAll(); } catch { /* ignore */ } });
    return { ...rec, voiced: false, reason: 'error:' + (e && e.message ? e.message.slice(0, 60) : 'unknown') };
  }
}

async function extractSerial (items, log) {
  const { createPraatWasm } = await import(DEFAULT_PRAAT_WASM);
  const praat = await createPraatWasm();
  const records = [];
  for (const item of items) records.push(analyzeToneAudioClip(praat, item));
  log(`extracted ${records.length} records (serial)`);
  return records;
}

async function extractParallel (dir, jobs, log) {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const worker = join(__dirname, 'toneaudio-worker.mjs');
  const outDir = mkdtempSync(join(tmpdir(), 'ta-feat-'));
  let done = 0;

  const runs = Array.from({ length: jobs }, (_, i) => {
    const out = join(outDir, `shard-${i}.json`);
    const child = fork(worker, [], {
      env: { ...process.env, SHARD_INDEX: String(i), SHARD_COUNT: String(jobs), SHARD_OUT: out, TONEAUDIO_DIR: dir },
      stdio: ['ignore', 'ignore', 'inherit', 'ipc']
    });
    return new Promise((resolve, reject) => {
      child.on('exit', (code) => {
        if (code !== 0) return reject(new Error(`toneaudio worker ${i} exited with code ${code}`));
        log(`  worker ${++done}/${jobs} finished`);
        resolve(JSON.parse(readFileSync(out, 'utf8')));
      });
      child.on('error', reject);
    });
  });

  return (await Promise.all(runs)).flat();
}

/** Every Nth manifest entry, per TONEAUDIO_STRIDE (default 1 = everything) — a quick smoke-test knob. */
export function applyStride (manifest) {
  const stride = Math.max(1, parseInt(process.env.TONEAUDIO_STRIDE || '1', 10));
  return stride === 1 ? manifest : manifest.filter((_, i) => i % stride === 0);
}

/** Extract features + classify for every clip in the corpus at `dir`. No caching (this corpus grows/changes across dated drops). */
export async function extractToneAudioFeatures (dir, { jobs = 1, log = () => {} } = {}) {
  const manifest = applyStride(buildManifest(dir));
  log(`${manifest.length} clips (${new Set(manifest.map(m => m.token)).size} distinct tokens)`);
  return jobs > 1 ? extractParallel(dir, jobs, log) : extractSerial(manifest, log);
}

export { buildManifest };
