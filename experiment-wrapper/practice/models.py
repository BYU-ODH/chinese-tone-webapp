"""
Sessions and attempts.

Each ItemAttempt stores the component's `attempt` event detail VERBATIM in
`payload`, and additionally flattens the per-syllable array into
SyllableAttempt rows. Both, deliberately: the summary screen and any
cross-participant analysis need to query per-tone accuracy, which is miserable
over JSON — but the payload also carries `scores`, `coefs` and `diagnostic`,
and the engine is still being tuned, so a re-analysis must be able to work from
what was actually captured rather than from what we thought to normalize at the
time. Keep the raw, index the derived.
"""

import uuid

from django.conf import settings
from django.db import models


class SessionMode(models.TextChoices):
    PRETEST = "pretest", "Pre-test"
    PRACTICE = "practice", "Practice"
    REVIEW = "review", "Review"
    TEST = "test", "Test"
    POSTTEST = "posttest", "Post-test"
    GUEST = "guest", "Open web app"


#: Modes that show pinyin tone marks. Kickoff notes: practice shows the tone
#: mark, actual lessons/tests don't; pinyin itself is always shown.
TONE_MARK_MODES = {SessionMode.PRACTICE, SessionMode.GUEST}

#: Modes that may only be run on their assigned day.
DAY_OF_ONLY_MODES = {SessionMode.PRETEST, SessionMode.TEST, SessionMode.POSTTEST}


class PracticeSession(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    participant = models.ForeignKey(
        "study.Participant",
        null=True,
        blank=True,
        on_delete=models.CASCADE,
        related_name="sessions",
        help_text="Null for guest sessions, which are not part of the study.",
    )
    lesson = models.ForeignKey("curriculum.Lesson", on_delete=models.PROTECT)
    mode = models.CharField(max_length=12, choices=SessionMode.choices)
    started_at = models.DateTimeField(auto_now_add=True)
    ended_at = models.DateTimeField(null=True, blank=True)
    completed = models.BooleanField(default=False)
    score = models.FloatField(null=True, blank=True)
    coins_earned = models.PositiveIntegerField(default=0)

    class Meta:
        ordering = ["-started_at"]

    def __str__(self):
        who = self.participant or "guest"
        return f"{who} · {self.lesson} · {self.mode}"

    @property
    def show_tone_marks(self):
        return self.mode in TONE_MARK_MODES

    @property
    def items(self):
        return list(self.lesson.items.all())

    @property
    def duration_seconds(self):
        end = self.ended_at
        if not end:
            return None
        return (end - self.started_at).total_seconds()

    def best_attempts(self):
        """One attempt per item — the best the learner managed — in item order."""
        rank = {"good": 3, "close": 2, "bad": 1}
        best = {}
        for attempt in self.attempts.select_related("item").all():
            current = best.get(attempt.item_id)
            if current is None or rank.get(attempt.verdict, 0) > rank.get(current.verdict, 0):
                best[attempt.item_id] = attempt
        return [best[i.id] for i in self.items if i.id in best]

    def recompute_score(self):
        items = self.items
        if not items:
            self.score = None
            return self.score
        passed = sum(1 for a in self.best_attempts() if a.passed)
        self.score = passed / len(items)
        return self.score


class ItemAttempt(models.Model):
    """One recording of one item. `ordinal` caps at MAX_ATTEMPTS_PER_ITEM."""

    session = models.ForeignKey(
        PracticeSession, on_delete=models.CASCADE, related_name="attempts"
    )
    item = models.ForeignKey("curriculum.Item", on_delete=models.PROTECT)
    ordinal = models.PositiveSmallIntegerField(default=1)
    created_at = models.DateTimeField(auto_now_add=True)

    # Straight off the component's `attempt` payload.
    voiced = models.BooleanField(default=False)
    reason = models.CharField(max_length=32, blank=True)
    segmentation_method = models.CharField(max_length=32, blank=True)
    register_trusted = models.BooleanField(default=False)
    duration_sec = models.FloatField(null=True, blank=True)
    elapsed_sec = models.FloatField(null=True, blank=True, help_text="Wrapper's per-item timer.")

    verdict = models.CharField(max_length=10, blank=True, help_text="Worst scored syllable.")
    passed = models.BooleanField(default=False)
    payload = models.JSONField(help_text="event.detail, verbatim.")
    audio = models.FileField(upload_to="attempts/", blank=True)

    class Meta:
        ordering = ["created_at"]
        constraints = [
            models.UniqueConstraint(
                fields=["session", "item", "ordinal"], name="uniq_attempt_ordinal"
            )
        ]

    def __str__(self):
        return f"{self.item} #{self.ordinal} · {self.verdict}"


class SyllableAttempt(models.Model):
    """The payload's per-syllable array, flattened so it can be queried."""

    attempt = models.ForeignKey(
        ItemAttempt, on_delete=models.CASCADE, related_name="syllables"
    )
    index = models.PositiveSmallIntegerField()
    base = models.CharField(max_length=16)
    pinyin = models.CharField(max_length=16, blank=True)
    citation_tone = models.PositiveSmallIntegerField()
    surface_tone = models.PositiveSmallIntegerField()
    matched_tone = models.PositiveSmallIntegerField(null=True, blank=True)
    best_tone = models.PositiveSmallIntegerField(null=True, blank=True)
    verdict = models.CharField(max_length=10, blank=True)
    target_score = models.FloatField(null=True, blank=True)
    diagnostic = models.CharField(max_length=240, blank=True)
    is_sandhi = models.BooleanField(default=False)
    is_neutral = models.BooleanField(default=False)
    is_optional = models.BooleanField(default=False)
    coefs = models.JSONField(null=True, blank=True)

    class Meta:
        ordering = ["attempt", "index"]

    def __str__(self):
        return f"{self.base}{self.surface_tone} · {self.verdict}"


class SpeakerCalibration(models.Model):
    """
    Persisted SpeakerNormalizer state, so a student calibrates once rather than
    at the start of every session. The component accepts a normalizer via its
    `normalizer` setter and skips calibration when one is already trusted.
    """

    participant = models.OneToOneField(
        "study.Participant", on_delete=models.CASCADE, related_name="calibration"
    )
    state = models.JSONField(default=dict)
    trusted = models.BooleanField(default=False)
    updated_at = models.DateTimeField(auto_now=True)

    def __str__(self):
        return f"calibration for {self.participant}"
