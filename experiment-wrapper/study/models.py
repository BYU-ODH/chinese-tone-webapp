"""Participants, cohorts, scheduling, and per-lesson rollups."""

from django.conf import settings
from django.db import models
from django.utils import timezone


class Cohort(models.Model):
    """A class/section. Scheduling and condition assignment hang off this."""

    name = models.CharField(max_length=120)
    course = models.ForeignKey("curriculum.Course", on_delete=models.PROTECT)
    instructor = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="cohorts"
    )

    def __str__(self):
        return self.name


class Participant(models.Model):
    user = models.OneToOneField(settings.AUTH_USER_MODEL, on_delete=models.CASCADE)
    cohort = models.ForeignKey(Cohort, on_delete=models.PROTECT, related_name="participants")
    study_id = models.CharField(
        max_length=32, unique=True, help_text="De-identified key used in analysis exports."
    )
    condition = models.CharField(max_length=32, blank=True, help_text="Experimental arm.")
    consented_at = models.DateTimeField(null=True, blank=True)
    enrolled_on = models.DateField(default=timezone.localdate)

    def __str__(self):
        return f"{self.user.get_username()} ({self.study_id})"

    @property
    def display_name(self):
        return self.user.get_short_name() or self.user.get_username()


class LessonAssignment(models.Model):
    """
    What a cohort may do on a given day.

    This is what enforces the kickoff note's "students allowed to practice
    previous lessons but actual tests not allowed, except on the day of":
    practice assignments stay open, test-like modes are checked against
    `available_on`.
    """

    cohort = models.ForeignKey(Cohort, on_delete=models.CASCADE, related_name="assignments")
    lesson = models.ForeignKey("curriculum.Lesson", on_delete=models.PROTECT)
    mode = models.CharField(max_length=12)
    available_on = models.DateField()

    class Meta:
        ordering = ["available_on", "lesson"]
        constraints = [
            models.UniqueConstraint(
                fields=["cohort", "lesson", "mode"], name="uniq_cohort_lesson_mode"
            )
        ]

    def __str__(self):
        return f"{self.lesson} · {self.mode} · {self.available_on}"


class LessonProgress(models.Model):
    """Per participant x lesson rollup. Powers the lesson path and history table."""

    class Status(models.TextChoices):
        LOCKED = "locked", "Locked"
        AVAILABLE = "available", "Available"
        IN_PROGRESS = "in_progress", "In progress"
        UNFINISHED = "unfinished", "Unfinished"
        COMPLETED = "completed", "Completed"

    participant = models.ForeignKey(
        Participant, on_delete=models.CASCADE, related_name="progress"
    )
    lesson = models.ForeignKey("curriculum.Lesson", on_delete=models.CASCADE)
    status = models.CharField(max_length=12, choices=Status.choices, default=Status.LOCKED)
    best_score = models.FloatField(null=True, blank=True)
    completed_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ["lesson"]
        verbose_name_plural = "lesson progress"
        constraints = [
            models.UniqueConstraint(
                fields=["participant", "lesson"], name="uniq_progress_per_lesson"
            )
        ]

    def __str__(self):
        return f"{self.participant} · {self.lesson} · {self.status}"
