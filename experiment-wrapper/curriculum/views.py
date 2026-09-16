"""Today's Lesson — the vocabulary/sentence overview before practice starts."""

from django.shortcuts import get_object_or_404, render
from django.utils import timezone

from practice.models import SessionMode

from .models import Lesson


def lesson_detail(request, slug):
    lesson = get_object_or_404(Lesson, slug=slug)
    mode = request.GET.get("mode", SessionMode.PRACTICE)
    if mode not in SessionMode.values:
        mode = SessionMode.PRACTICE
    if not request.user.is_authenticated:
        mode = SessionMode.GUEST
    return render(
        request,
        "curriculum/lesson_detail.html",
        {
            "lesson": lesson,
            "mode": mode,
            "today": timezone.localdate(),
            "words": lesson.words,
            "sentences": lesson.sentences,
        },
    )
