"""
Tone-mark handling for the display layer.

The kickoff notes require that tests and reviews show pinyin *without* tone
marks while practice shows them. `<tone-phrase-trainer>` renders whatever
pinyin string it is given (`spokenPinyin()`), with no attribute to suppress the
diacritic — so rather than reach into its shadow root, we strip the diacritic
from the phrase data before handing it over.

Only the display strings change. `base`, `tone`, `surfaceTones` and
`acceptedTones` are untouched, so segmentation and scoring behave identically
in every mode. That is the whole point: hiding the answer must not change the
grading.
"""

import unicodedata

#: ü must survive decomposition — it is a vowel quality, not a tone mark.
_KEEP = {"̈"}  # combining diaeresis


def strip_tone_marks(text):
    if not text:
        return text
    decomposed = unicodedata.normalize("NFD", text)
    kept = [
        ch
        for ch in decomposed
        if unicodedata.category(ch) != "Mn" or ch in _KEEP
    ]
    return unicodedata.normalize("NFC", "".join(kept))


def phrase_without_tone_marks(phrase):
    """A copy of a component phrase with every displayed pinyin de-marked."""
    out = dict(phrase)
    out["syllables"] = [
        {
            key: (strip_tone_marks(value) if key in ("pinyin", "surfacePinyin", "altPinyin") else value)
            for key, value in syllable.items()
        }
        for syllable in phrase.get("syllables", [])
    ]
    return out
