# Tone Tiger — experiment wrapper

Django app that wraps the repo's existing multi-syllable tone trainer for a
pre/post-test learning-outcomes study. Design source: the second row of frames
in the [Chinese Tones Figma file](https://www.figma.com/design/m5twcRMeQzUcdot9YusNGC/Chinese-Tones?node-id=0-1)
(`Landing Page` … `Frame 82`). Plan and model rationale live in
[`../EXPERIMENT_APP_PLAN.md`](../EXPERIMENT_APP_PLAN.md).

## What this app does and does not do

The tone engine is **not** vendored here. `docs/multi-syllable/` already ships
`<tone-phrase-trainer>`, a shadow-DOM custom element that records, denoises,
segments, classifies, draws the contour and emits an `attempt` event. This app
is the host around it:

| Concern | Owner |
|---|---|
| Mic, Praat/WASM, segmentation, classification, contour viz, per-syllable verdict | `<tone-phrase-trainer>` |
| Accounts, cohorts, scheduling, practice/test mode, attempt persistence, summaries, history, gamification, faculty authoring | Django |

`STATICFILES_DIRS` points at `../docs`, so the engine serves from one place and
the GitHub Pages demo keeps working. Don't copy those files in.

## Running it

```bash
uv sync
uv run python manage.py migrate
uv run python manage.py seed_demo        # demo course, student, shop
uv run python manage.py import_phrases   # optional: docs/multi-syllable/phrases.js
uv run python manage.py runserver
```

Log in as `student` / `tonetiger`, or `teacher` / `tonetiger` for `/admin/`.

```bash
uv run python manage.py test
```

## Apps

- **`curriculum`** — `Course`, `Lesson`, `Item`, `ItemSyllable`. `ItemSyllable`
  rows are the editable source of truth; `Item.phrase_json` is a cache of
  exactly the object the component consumes, rebuilt on save.
- **`study`** — `Cohort`, `Participant`, `LessonAssignment` (which enforces the
  day-of-only rule for tests), `LessonProgress`.
- **`practice`** — `PracticeSession`, `ItemAttempt`, `SyllableAttempt`,
  `SpeakerCalibration`. Attempts store the component payload verbatim *and*
  flattened, so the summary can query per-tone accuracy while a later
  re-analysis can still work from what was actually captured.
- **`rewards`** — coins, shop, and the tiger. Severable if that scope is cut.

## Modes

`SessionMode` drives what the learner sees. Practice and guest show pinyin
**with** tone marks; pre-test, test, review and post-test show pinyin
**without** them. Marks are stripped from the phrase data before it reaches the
component (`curriculum/pinyin.py`) — `base`, `tone` and `surfaceTones` are
untouched, so hiding the answer never changes the grading.

## Known gaps

- **"Correct your voice" is not implemented.** It needs per-item reference
  audio; `Item.reference_audio` exists but is empty. `tone_perfect/` covers
  single syllables only, so the Lesson 2 sentences have no native recordings.
- **Calibration does not persist yet.** `SpeakerCalibration` and the
  rehydration hook in `static/js/practice.js` are in place, but
  `SpeakerNormalizer` has no `toJSON`/`fromJSON`, so nothing is stored.
- **Neutral tone is a live engine blocker.** `classify(0, …)` returns
  `targetScore: undefined`, which poisons the guided DP to `NaN`. Lesson 2
  contains 呢, 什么 and 名字. See `../PLAN.md`, divergence 5.
- Coin economy (gold = passed first try, silver = passed on retry) is a
  placeholder reading of the two coin counts in the Figma summary.
