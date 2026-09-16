"""The practice run itself, its completion screen, and the summary."""

import json

from django.conf import settings
from django.db import IntegrityError
from django.http import Http404, JsonResponse
from django.shortcuts import get_object_or_404, redirect, render
from django.utils import timezone
from django.views.decorators.http import require_POST

from curriculum.models import Item, Lesson
from curriculum.pinyin import phrase_without_tone_marks
from rewards.models import Wallet
from study.models import LessonAssignment, LessonProgress

from .models import (
    DAY_OF_ONLY_MODES,
    ItemAttempt,
    PracticeSession,
    SessionMode,
    SpeakerCalibration,
)
from .scoring import (
    VERDICT_COLOR,
    VERDICT_LABEL,
    coins_for,
    donut_gradient,
    first_diagnostic,
    record_attempt,
    tone_breakdown,
    verdict_mix,
)


def _clock(seconds):
    if not seconds:
        return "0:00"
    seconds = int(seconds)
    return f"{seconds // 60}:{seconds % 60:02d}"


def _participant(request):
    if not request.user.is_authenticated:
        return None
    return getattr(request.user, "participant", None)


def _may_run(participant, lesson, mode):
    """Day-of-only rule: tests are gated on their assignment date, practice isn't."""
    if mode not in DAY_OF_ONLY_MODES:
        return True
    if participant is None:
        return False
    return LessonAssignment.objects.filter(
        cohort=participant.cohort,
        lesson=lesson,
        mode=mode,
        available_on=timezone.localdate(),
    ).exists()


def start_session(request, slug):
    lesson = get_object_or_404(Lesson, slug=slug)
    participant = _participant(request)
    mode = request.GET.get("mode", SessionMode.PRACTICE)
    if mode not in SessionMode.values:
        mode = SessionMode.PRACTICE
    if participant is None:
        mode = SessionMode.GUEST
    if not _may_run(participant, lesson, mode):
        raise Http404("That test is not open today.")

    session = PracticeSession.objects.create(
        participant=participant, lesson=lesson, mode=mode
    )
    if participant is not None:
        LessonProgress.objects.update_or_create(
            participant=participant,
            lesson=lesson,
            defaults={"status": LessonProgress.Status.IN_PROGRESS},
        )
    return redirect("practice_run", session_id=session.id)


def practice_run(request, session_id):
    session = get_object_or_404(
        PracticeSession.objects.select_related("lesson"), pk=session_id
    )
    items = session.items
    if not items:
        raise Http404("This lesson has no items yet.")

    attempts = {}
    for attempt in session.attempts.all():
        attempts.setdefault(attempt.item_id, []).append(attempt)

    pips = []
    for item in items:
        made = attempts.get(item.id, [])
        best = max(made, key=lambda a: a.passed, default=None)
        pips.append(
            {
                "state": (
                    "empty"
                    if not made
                    else "good"
                    if any(a.passed for a in made)
                    else "bad"
                ),
                "item": item,
            }
        )

    calibration = None
    if session.participant is not None:
        row = SpeakerCalibration.objects.filter(participant=session.participant).first()
        if row and row.trusted:
            calibration = row.state

    # Practice shows the tone mark; tests and reviews do not. Stripped at the
    # data layer so the component needs no change and scoring is unaffected.
    phrases = [item.phrase_json for item in items]
    if not session.show_tone_marks:
        phrases = [phrase_without_tone_marks(p) for p in phrases]

    payload = {
        "sessionId": str(session.id),
        "phrases": phrases,
        "itemIds": [item.id for item in items],
        "referenceAudio": [
            item.reference_audio.url if item.reference_audio else None for item in items
        ],
        "showToneMarks": session.show_tone_marks,
        "maxAttempts": settings.MAX_ATTEMPTS_PER_ITEM,
        "calibration": calibration,
        "attemptUrl": f"/sessions/{session.id}/attempts/",
        "doneUrl": f"/sessions/{session.id}/done/",
    }

    return render(
        request,
        "practice/run.html",
        {
            "session": session,
            "lesson": session.lesson,
            "pips": pips,
            "config": payload,
        },
    )


@require_POST
def submit_attempt(request, session_id):
    session = get_object_or_404(PracticeSession, pk=session_id)
    try:
        body = json.loads(request.body.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        return JsonResponse({"error": "malformed body"}, status=400)

    item = get_object_or_404(Item, pk=body.get("itemId"), lesson=session.lesson)
    detail = body.get("detail")
    if not isinstance(detail, dict):
        return JsonResponse({"error": "missing attempt detail"}, status=400)

    used = session.attempts.filter(item=item).count()
    if used >= settings.MAX_ATTEMPTS_PER_ITEM:
        return JsonResponse(
            {"error": "attempt limit reached", "attemptsRemaining": 0}, status=409
        )

    try:
        attempt = record_attempt(
            session, item, detail, ordinal=used + 1, elapsed_sec=body.get("elapsedSec")
        )
    except IntegrityError:
        return JsonResponse({"error": "duplicate attempt"}, status=409)

    session.recompute_score()
    session.save(update_fields=["score"])

    remaining = settings.MAX_ATTEMPTS_PER_ITEM - attempt.ordinal
    return JsonResponse(
        {
            "verdict": attempt.verdict,
            "label": VERDICT_LABEL.get(attempt.verdict, ""),
            "color": VERDICT_COLOR.get(attempt.verdict, "#d1d1d1"),
            "passed": attempt.passed,
            # After failing ONCE a sentence appears to give advice (July 22 notes).
            "diagnostic": first_diagnostic(attempt),
            "attemptsRemaining": max(remaining, 0),
            "advance": attempt.passed or remaining <= 0,
        }
    )


@require_POST
def finish_session(request, session_id):
    """Close the session out and bank the coins. Idempotent."""
    session = get_object_or_404(PracticeSession, pk=session_id)
    if not session.completed:
        gold, silver = coins_for(session)
        session.ended_at = timezone.now()
        session.completed = True
        session.recompute_score()
        session.coins_earned = gold + silver
        session.save(
            update_fields=["ended_at", "completed", "score", "coins_earned"]
        )

        participant = session.participant
        if participant is not None:
            threshold = session.lesson.pass_threshold
            passed = session.score is not None and session.score >= threshold
            progress, _ = LessonProgress.objects.get_or_create(
                participant=participant, lesson=session.lesson
            )
            if passed:
                progress.status = LessonProgress.Status.COMPLETED
                progress.completed_at = session.ended_at
            else:
                progress.status = LessonProgress.Status.UNFINISHED
            if progress.best_score is None or (session.score or 0) > progress.best_score:
                progress.best_score = session.score
            progress.save()

            wallet, _ = Wallet.objects.get_or_create(participant=participant)
            wallet.coins += session.coins_earned
            wallet.save(update_fields=["coins"])

    return JsonResponse({"doneUrl": f"/sessions/{session.id}/done/"})


def session_done(request, session_id):
    session = get_object_or_404(
        PracticeSession.objects.select_related("lesson"), pk=session_id
    )
    gold, silver = coins_for(session)
    return render(
        request,
        "practice/done.html",
        {"session": session, "lesson": session.lesson, "gold": gold, "silver": silver},
    )


def session_summary(request, session_id):
    session = get_object_or_404(
        PracticeSession.objects.select_related("lesson"), pk=session_id
    )
    best = session.best_attempts()
    by_item = {a.item_id: a for a in best}

    def decorate(items):
        out = []
        for item in items:
            attempt = by_item.get(item.id)
            verdict = attempt.verdict if attempt else ""
            out.append(
                {
                    "item": item,
                    "attempt": attempt,
                    "verdict": verdict,
                    "color": VERDICT_COLOR.get(verdict, "#d1d1d1"),
                    "pinyin": item.pinyin_display,
                }
            )
        return out

    mix = verdict_mix(best)
    gold, silver = coins_for(session)
    passed = sum(1 for a in best if a.passed)

    return render(
        request,
        "practice/summary.html",
        {
            "session": session,
            "lesson": session.lesson,
            "words": decorate(session.lesson.words),
            "sentences": decorate(session.lesson.sentences),
            "tone_rows": tone_breakdown(best),
            "mix": mix,
            "donut": donut_gradient(mix),
            "score_pct": round(100 * session.score) if session.score is not None else 0,
            "passed": passed,
            "total": len(session.items),
            "time_display": _clock(session.duration_seconds),
            "gold": gold,
            "silver": silver,
        },
    )
