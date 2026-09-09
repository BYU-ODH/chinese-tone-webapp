/*
 * Tone sandhi rules for Beijing/Mainland Putonghua.
 *
 * This is an AUTHORING-TIME tool, not a hot-path call. For a curriculum of
 * known words/phrases, run resolveSandhi() once per entry, have a human
 * review the output, and store the resulting surfaceTones AND acceptedTones
 * on the entry itself. classifyUtterance() (utterance.js) then scores
 * against those stored arrays directly — it never calls resolveSandhi()
 * live. Treating
 * this as an authoring tool rather than a runtime dependency means a bad
 * guess here never reaches a learner uncorrected.
 *
 * Rules implemented (citations: Chao 1968; Duanmu 2000/2007; Shih 1986;
 * Lin 2007):
 *   - T3 + T3 -> T2 + T3 (pairwise, obligatory).
 *   - Runs of exactly 3 underlying T3: resolved, but with a genuinely
 *     OPTIONAL position. Confirmed with our Chinese collaborators using
 *     `wo3 ye3 hen3`, which is acceptable as EITHER `wo2 ye2 hen3` or
 *     `wo3 ye2 hen3`. What both share is the invariant this encodes — the
 *     final syllable keeps T3 and the penultimate becomes T2 — and they
 *     differ only on the run-initial syllable, which really does vary with
 *     prosodic grouping (Shih 1986). That position is therefore reported as
 *     accepting either tone rather than collapsed to one, so a learner who
 *     picks the other legitimate realization is never marked wrong.
 *   - Runs of 4 or more underlying T3: still flagged, never guessed. The
 *     collaborators' answer covered the 3-syllable case; extrapolating the
 *     same grouping to longer runs would be exactly the kind of guess this
 *     file exists to avoid.
 *   - bu4 (不): -> bu2 before T4, else stays bu4.
 *   - yi1 (一): -> yi2 before T4, yi4 before T1/T2/T3. Counting/ordinal/
 *     isolated uses are NOT sandhi'd — the caller must not tag those as
 *     morph:'yi' in the first place, since that context isn't recoverable
 *     from tone sequence alone either.
 *   - Neutral tone / reduplication: out of v1 scoring scope (see plan).
 *     Represented here as citation tone 0 and passed through unchanged;
 *     the display layer renders these grey and excludes them from the
 *     verdict rather than scoring an unvalidated T0 model.
 */

/**
 * @typedef {Object} SandhiSyllable
 * @property {number} tone   Citation (dictionary) tone, 1-4. Use 0 for a
 *                            syllable already known to be neutral/light
 *                            (e.g. from a corpus annotation or a morph tag
 *                            resolved upstream) — passed through unchanged.
 * @property {string} [morph] 'bu' | 'yi' | 'redup', for syllables whose
 *                            sandhi depends on lexical identity, not just
 *                            adjacent tones. Omit for ordinary syllables.
 */

/**
 * @typedef {Object} SandhiFlag
 * @property {number} start
 * @property {number} end
 * @property {string} reason
 * @property {number} runLength
 */

/**
 * Resolve citation tones to surface (realized) tones for one phrase.
 *
 * @param {SandhiSyllable[]} syllables
 * @returns {{ surfaceTones: number[], acceptedTones: number[][], flags: SandhiFlag[] }}
 *   surfaceTones is the same length as syllables and holds ONE realization
 *   per position — the form to display as "say this".
 *
 *   acceptedTones is the same length again, and holds EVERY acceptable
 *   realization for each position, with the displayed one first
 *   (acceptedTones[i][0] === surfaceTones[i] always). Almost every entry is
 *   a single tone; an entry with two means the position is genuinely
 *   optional and a scorer must accept either. Scoring code should read this
 *   rather than surfaceTones — using surfaceTones alone would mark a
 *   correct alternative realization wrong.
 *
 *   Positions inside a flagged run are left at their citation tone
 *   (unresolved) rather than guessed — the caller must supply the correct
 *   surface tone for those positions by hand (e.g. by consulting a human
 *   reviewer or a corpus annotation) before storing this as curriculum data.
 */
export function resolveSandhi (syllables) {
  const tones = syllables.map(s => s.tone);
  const surface = tones.slice();
  const flags = [];

  // Lexical morphs (bu4/yi1/reduplication) first: these depend on word
  // identity, not on whether the syllable happens to be a T3.
  syllables.forEach((s, i) => {
    if (s.morph === 'bu') {
      surface[i] = tones[i + 1] === 4 ? 2 : 4;
    } else if (s.morph === 'yi') {
      const next = tones[i + 1];
      if (next === 4) surface[i] = 2;
      else if (next === 1 || next === 2 || next === 3) surface[i] = 4;
    } else if (s.morph === 'redup') {
      surface[i] = 0;
    }
  });

  // T3 + T3 sandhi, over runs of the UNDERLYING (citation) T3s — a bu4/yi1
  // resolution above never changes T3-hood, so this scans `tones`, not the
  // partially-resolved `surface`.
  const accepted = surface.map(t => [t]);
  let i = 0;
  while (i < tones.length) {
    if (tones[i] !== 3) { i++; continue; }
    let j = i;
    while (j + 1 < tones.length && tones[j + 1] === 3) j++;
    const runLength = j - i + 1;

    if (runLength === 2) {
      surface[i] = 2;                     // T3+T3 -> T2+T3, obligatory
      accepted[i] = [2];
    } else if (runLength === 3) {
      // Per the collaborators' `wo3 ye3 hen3` answer (see the file header):
      // the penultimate rises and the final stays low in BOTH acceptable
      // realizations; only the run-initial syllable varies.
      surface[j - 1] = 2;
      accepted[j - 1] = [2];
      accepted[j] = [surface[j]];         // stays T3
      // Displayed form keeps the citation tone (the smaller deviation from
      // what the learner looked up); the alternative is equally correct and
      // is listed second, not discarded.
      accepted[i] = [surface[i], 2];
    } else if (runLength >= 4) {
      flags.push({ start: i, end: j, reason: 'ambiguous-t3-run', runLength });
    }
    // runLength === 1 is an isolated T3: no adjacency, no sandhi, nothing to
    // flag. Guarded explicitly because a bare `else` here silently flagged
    // every single T3 in the corpus as ambiguous.

    i = j + 1;
  }

  return { surfaceTones: surface, acceptedTones: accepted, flags };
}
