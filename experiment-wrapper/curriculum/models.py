"""
Faculty-authored content.

`ItemSyllable` rows are the editable source of truth; `Item.phrase_json` is a
denormalized cache of exactly the object `<tone-phrase-trainer>` consumes, so
the practice view serves the component's contract with no per-request
transform. Rebuilt on save — never hand-edit it.

Note that `surface_tone` is STORED, not computed. sandhi.js is an
authoring-time tool by design: resolveSandhi() runs once, a human reviews it,
and the reviewed result is committed. Keeping that property here is why these
are real columns and not a runtime call.
"""

from django.db import models


class Course(models.Model):
    name = models.CharField(max_length=120)
    slug = models.SlugField(unique=True)

    def __str__(self):
        return self.name


class Lesson(models.Model):
    course = models.ForeignKey(Course, on_delete=models.CASCADE, related_name="lessons")
    number = models.PositiveIntegerField()
    slug = models.SlugField(unique=True)
    title = models.CharField(max_length=120)
    pass_threshold = models.FloatField(
        default=0.8, help_text="Fraction of items passed for the lesson to count as complete."
    )

    class Meta:
        ordering = ["course", "number"]
        constraints = [
            models.UniqueConstraint(fields=["course", "number"], name="uniq_lesson_number")
        ]

    def __str__(self):
        return f"Lesson {self.number}: {self.title}"

    @property
    def words(self):
        return self.items.filter(kind=Item.Kind.WORD)

    @property
    def sentences(self):
        return self.items.filter(kind=Item.Kind.SENTENCE)


class Item(models.Model):
    """One thing the learner says. Maps 1:1 to a component `phrase`."""

    class Kind(models.TextChoices):
        WORD = "word", "Vocabulary"
        SENTENCE = "sentence", "Sentence"

    lesson = models.ForeignKey(Lesson, on_delete=models.CASCADE, related_name="items")
    kind = models.CharField(max_length=8, choices=Kind.choices, default=Kind.WORD)
    order = models.PositiveIntegerField(default=0)
    slug = models.SlugField(help_text="Becomes phrase.id, e.g. 'ni-hao'.")
    hanzi = models.CharField(max_length=64)
    gloss = models.CharField(max_length=120, blank=True)
    note = models.CharField(max_length=240, blank=True)
    pinyin_override = models.CharField(
        max_length=120,
        blank=True,
        help_text="Canonical pinyin for display. Falls back to joining syllables.",
    )
    reference_audio = models.FileField(
        upload_to="reference/", blank=True, help_text="Native recording for 'Correct your voice'."
    )
    phrase_json = models.JSONField(default=dict, editable=False)

    class Meta:
        # "word" sorts after "sentence", so -kind puts vocabulary first.
        ordering = ["lesson", "-kind", "order"]
        constraints = [
            models.UniqueConstraint(fields=["lesson", "slug"], name="uniq_item_slug_per_lesson")
        ]

    def __str__(self):
        return f"{self.hanzi} ({self.slug})"

    @property
    def pinyin_display(self):
        """
        Authored pinyin if a human supplied it, else a join of the syllables.
        Words join tight (shénme); sentences get spaces, which is the best a
        syllable list can do without knowing word boundaries.
        """
        if self.pinyin_override:
            return self.pinyin_override
        parts = [syl.get("pinyin", "") for syl in self.phrase_json.get("syllables", [])]
        return ("" if self.kind == self.Kind.WORD else " ").join(parts)

    def build_phrase(self):
        """The exact shape phrases.js exports, assembled from ItemSyllable rows."""
        syllables = []
        surface_tones = []
        accepted = []
        has_optional = False
        for syl in self.syllables.all():
            entry = {"pinyin": syl.pinyin, "base": syl.base, "tone": syl.tone}
            if syl.surface_pinyin:
                entry["surfacePinyin"] = syl.surface_pinyin
            if syl.alt_pinyin:
                entry["altPinyin"] = syl.alt_pinyin
            if syl.morph:
                entry["morph"] = syl.morph
            syllables.append(entry)
            surface_tones.append(syl.surface_tone)
            options = syl.accepted_tones or [syl.surface_tone]
            if len(options) > 1:
                has_optional = True
            accepted.append(options)

        phrase = {
            "id": self.slug,
            "hanzi": self.hanzi,
            "gloss": self.gloss,
            "syllables": syllables,
            "surfaceTones": surface_tones,
        }
        if self.note:
            phrase["note"] = self.note
        # acceptedTones is present ONLY when some position is genuinely optional
        # (a 3-long T3 run's first syllable), matching phrases.js.
        if has_optional:
            phrase["acceptedTones"] = accepted
        return phrase

    def refresh_phrase_json(self, save=True):
        self.phrase_json = self.build_phrase()
        if save:
            super().save(update_fields=["phrase_json"])
        return self.phrase_json


class ItemSyllable(models.Model):
    """Mirrors phrases.js field-for-field. See that file's header for semantics."""

    class Morph(models.TextChoices):
        NONE = "", "—"
        BU = "bu", "不"
        YI = "yi", "一"
        REDUP = "redup", "reduplication"

    item = models.ForeignKey(Item, on_delete=models.CASCADE, related_name="syllables")
    order = models.PositiveIntegerField(default=0)
    pinyin = models.CharField(max_length=16, help_text="Citation form, with diacritic.")
    surface_pinyin = models.CharField(
        max_length=16, blank=True, help_text="Only when sandhi changes it."
    )
    alt_pinyin = models.CharField(
        max_length=16, blank=True, help_text="Only for a genuinely optional position."
    )
    base = models.CharField(max_length=16, help_text="Tone-stripped; key into targets.json.")
    tone = models.PositiveSmallIntegerField(help_text="Citation tone 1-4, or 0 for neutral.")
    surface_tone = models.PositiveSmallIntegerField(help_text="What the learner should SAY.")
    accepted_tones = models.JSONField(
        default=list, blank=True, help_text="Empty unless the position is optional."
    )
    morph = models.CharField(max_length=8, choices=Morph.choices, blank=True, default="")

    class Meta:
        ordering = ["item", "order"]
        constraints = [
            models.UniqueConstraint(fields=["item", "order"], name="uniq_syllable_order")
        ]

    def __str__(self):
        return f"{self.pinyin} ({self.base}{self.tone})"
