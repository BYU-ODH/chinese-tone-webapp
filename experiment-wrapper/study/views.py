"""Landing, dashboard, and account history."""

from django.contrib.auth.decorators import login_required
from django.db.models import Sum
from django.shortcuts import get_object_or_404, redirect, render
from django.utils import timezone

from curriculum.models import Course, Lesson
from practice.models import ItemAttempt, PracticeSession, SessionMode
from practice.scoring import donut_gradient, tone_breakdown, verdict_mix
from rewards.models import Wallet

from .lesson_path import build_path
from .models import LessonAssignment, LessonProgress


def _statuses_for(participant, lessons):
    """Map lesson id -> status, unlocking the first lesson so a new user can start."""
    rows = {p.lesson_id: p.status for p in participant.progress.all()} if participant else {}
    statuses = {}
    previous_done = True
    for lesson in lessons:
        status = rows.get(lesson.id)
        if status is None:
            status = LessonProgress.Status.AVAILABLE if previous_done else LessonProgress.Status.LOCKED
        statuses[lesson.id] = status
        previous_done = status == LessonProgress.Status.COMPLETED
    return statuses


def _current_lesson(lessons, statuses):
    for lesson in lessons:
        if statuses.get(lesson.id) != LessonProgress.Status.COMPLETED:
            return lesson
    return lessons[-1] if lessons else None


DEFAULT_COURSE = "mandarin-1"


def _course_lessons(participant=None):
    """Only the learner's own course appears on the path."""
    slug = participant.cohort.course.slug if participant else DEFAULT_COURSE
    return list(Lesson.objects.filter(course__slug=slug))


def landing(request):
    if request.user.is_authenticated:
        return redirect("dashboard")
    lessons = _course_lessons()
    statuses = {lesson.id: LessonProgress.Status.LOCKED for lesson in lessons}
    if lessons:
        statuses[lessons[0].id] = LessonProgress.Status.AVAILABLE
    current = _current_lesson(lessons, statuses)
    return render(
        request,
        "study/landing.html",
        {
            "path": build_path(lessons, current.id if current else None, statuses),
            "first_lesson": lessons[0] if lessons else None,
            "hide_nav_links": True,
        },
    )


@login_required
def dashboard(request):
    participant = getattr(request.user, "participant", None)
    lessons = _course_lessons(participant)
    statuses = _statuses_for(participant, lessons)
    current = _current_lesson(lessons, statuses)

    today = timezone.localdate()
    todays_assignment = None
    if participant:
        todays_assignment = (
            LessonAssignment.objects.filter(cohort=participant.cohort, available_on=today)
            .select_related("lesson")
            .first()
        )

    todays_lesson = todays_assignment.lesson if todays_assignment else current
    previous_session = (
        PracticeSession.objects.filter(participant=participant, completed=True)
        .exclude(lesson=todays_lesson)
        .select_related("lesson")
        .first()
        if participant
        else None
    )

    return render(
        request,
        "study/dashboard.html",
        {
            "today": today,
            "todays_lesson": todays_lesson,
            "todays_mode": todays_assignment.mode if todays_assignment else SessionMode.PRACTICE,
            "previous_session": previous_session,
            "path": build_path(lessons, todays_lesson.id if todays_lesson else None, statuses),
        },
    )


@login_required
def history(request):
    participant = getattr(request.user, "participant", None)
    if participant is None:
        return redirect("dashboard")

    sessions = list(
        PracticeSession.objects.filter(participant=participant)
        .select_related("lesson")
        .order_by("-started_at")
    )
    attempts = list(
        ItemAttempt.objects.filter(session__participant=participant).prefetch_related("syllables")
    )

    rows = []
    total_seconds = 0
    scored_sessions = 0
    score_total = 0.0
    for session in sessions:
        best = session.best_attempts()
        passed = sum(1 for a in best if a.passed)
        seconds = session.duration_seconds or 0
        total_seconds += seconds
        if session.score is not None:
            score_total += session.score
            scored_sessions += 1
        rows.append(
            {
                "session": session,
                "lesson": session.lesson,
                "status": "Completed" if session.completed else "Unfinished",
                "score_pct": round(100 * session.score) if session.score is not None else None,
                "passed": passed,
                "total": len(session.items),
                "time_display": f"{int(seconds) // 60}:{int(seconds) % 60:02d}",
                "coins": session.coins_earned,
            }
        )

    wallet = Wallet.objects.filter(participant=participant).first()
    avg_score = round(100 * score_total / scored_sessions) if scored_sessions else None
    avg_seconds = round(total_seconds / len(sessions)) if sessions else 0
    mix = verdict_mix(attempts)

    return render(
        request,
        "study/history.html",
        {
            "rows": rows,
            "tone_rows": tone_breakdown(attempts),
            "mix": mix,
            "donut": donut_gradient(mix),
            "avg_score": avg_score,
            "avg_time_display": f"{avg_seconds // 60}:{avg_seconds % 60:02d}",
            "total_coins": wallet.coins if wallet else 0,
            "sessions_count": len(sessions),
        },
    )
