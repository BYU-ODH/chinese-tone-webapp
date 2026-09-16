"""
Turning a component `attempt` payload into rows, and rows back into the numbers
the summary screen shows.

`passed` is re-derived here from the payload rather than trusted from the
client: this is graded data that gates lesson completion, so the browser does
not get to assert it.
"""

from collections import OrderedDict

from django.db import transaction

from .models import ItemAttempt, SyllableAttempt

#: Verdicts that count as passing an item. `close` ("Almost") does not pass —
#: it is feedback, not a pass. `neutral` syllables are unscored (classifier.js's
#: tone-0 guard) and `uncertain` means we never heard it clearly.
PASSING_VERDICTS = {"good"}
VERDICT_RANK = {"good": 3, "close": 2, "bad": 1, "uncertain": 0}

VERDICT_LABEL = {
    "good": "Nice!",
    "close": "Almost",
    "bad": "Try Again",
    "uncertain": "Not heard",
    "neutral": "light",
}

#: Figma verdict colours (Frame 72 / Frame 75).
VERDICT_COLOR = {
    "good": "#08a300",
    "close": "#ffaf03",
    "bad": "#da4f3a",
    "uncertain": "#d1d1d1",
    "neutral": "#d1d1d1",
}


def worst_verdict(syllable_payloads):
    """
    An item is only as good as its weakest scored syllable. Neutral positions
    are skipped — a phrase ending in a neutral particle can still be all
    correct (see result.js `aggregate`).
    """
    scored = [
        s.get("verdict")
        for s in syllable_payloads
        if not s.get("neutral") and s.get("verdict")
    ]
    if not scored:
        return ""
    return min(scored, key=lambda v: VERDICT_RANK.get(v, 0))


@transaction.atomic
def record_attempt(session, item, payload, ordinal=None, elapsed_sec=None, audio=None):
    """Persist one `attempt` event. Returns the ItemAttempt."""
    if ordinal is None:
        ordinal = session.attempts.filter(item=item).count() + 1

    syllables = payload.get("syllables") or []
    verdict = worst_verdict(syllables)

    attempt = ItemAttempt.objects.create(
        session=session,
        item=item,
        ordinal=ordinal,
        voiced=bool(payload.get("voiced")),
        reason=payload.get("reason") or "",
        segmentation_method=payload.get("segmentationMethod") or "",
        register_trusted=bool(payload.get("registerTrusted")),
        duration_sec=payload.get("durationSec"),
        elapsed_sec=elapsed_sec,
        verdict=verdict,
        passed=verdict in PASSING_VERDICTS,
        payload=payload,
    )
    if audio is not None:
        attempt.audio = audio
        attempt.save(update_fields=["audio"])

    SyllableAttempt.objects.bulk_create(
        [
            SyllableAttempt(
                attempt=attempt,
                index=s.get("index", i),
                base=s.get("base") or "",
                pinyin=s.get("pinyin") or "",
                citation_tone=s.get("citationTone") or 0,
                surface_tone=s.get("surfaceTone") or 0,
                matched_tone=s.get("matchedTone"),
                best_tone=s.get("bestTone"),
                verdict=s.get("verdict") or "",
                target_score=s.get("targetScore"),
                diagnostic=(s.get("diagnostic") or "")[:240],
                is_sandhi=bool(s.get("sandhi")),
                is_neutral=bool(s.get("neutral")),
                is_optional=bool(s.get("optional")),
                coefs=s.get("coefs"),
            )
            for i, s in enumerate(syllables)
        ]
    )
    return attempt


def first_diagnostic(attempt):
    """
    At most ONE actionable tip, the first in reading order — showing every
    syllable's diagnostic at once buries the thing worth fixing (result.js
    `summaryHtml` makes the same call).
    """
    for syl in attempt.syllables.all():
        if syl.diagnostic and syl.verdict in ("bad", "close"):
            return syl.diagnostic
    return ""


def tone_breakdown(attempts):
    """
    Per-tone accuracy across a set of attempts, keyed by SURFACE tone — what the
    learner was actually asked to produce. Neutral (tone 0) is excluded because
    it is never scored.
    """
    buckets = OrderedDict((t, {"scored": 0, "good": 0}) for t in (1, 2, 3, 4))
    for attempt in attempts:
        for syl in attempt.syllables.all():
            if syl.is_neutral or syl.surface_tone not in buckets:
                continue
            buckets[syl.surface_tone]["scored"] += 1
            if syl.verdict == "good":
                buckets[syl.surface_tone]["good"] += 1

    rows = []
    for tone, counts in buckets.items():
        # A tone with nothing to score is not 0% -- it is absent. Saying 0%
        # would read as total failure on a lesson that simply has no T1 in it.
        scored = counts["scored"]
        pct = round(100 * counts["good"] / scored) if scored else None
        rows.append(
            {
                "tone": tone,
                "pct": pct,
                "scored": scored,
                "color": _bar_color(pct) if pct is not None else "#f3f3f3",
            }
        )
    return rows


def _bar_color(pct):
    if pct >= 70:
        return VERDICT_COLOR["good"]
    if pct >= 30:
        return VERDICT_COLOR["close"]
    return VERDICT_COLOR["bad"]


def verdict_mix(attempts):
    """Counts + percentages for the Great / Almost / Keep-trying donut."""
    counts = {"good": 0, "close": 0, "bad": 0}
    for attempt in attempts:
        if attempt.verdict in counts:
            counts[attempt.verdict] += 1
    total = sum(counts.values()) or 1
    return [
        {
            "key": key,
            "label": label,
            "count": counts[key],
            "pct": round(100 * counts[key] / total),
            "color": VERDICT_COLOR[key],
        }
        for key, label in (("good", "Great"), ("close", "Almost"), ("bad", "Keep trying"))
    ]


def donut_gradient(mix):
    """A conic-gradient value for the summary donut, in Great/Almost/Bad order."""
    stops = []
    cursor = 0.0
    for slice_ in mix:
        if slice_["pct"] <= 0:
            continue
        end = cursor + slice_["pct"]
        stops.append(f"{slice_['color']} {cursor}% {end}%")
        cursor = end
    if not stops:
        return "#f3f3f3 0% 100%"
    if cursor < 100:
        stops.append(f"#f3f3f3 {cursor}% 100%")
    return ", ".join(stops)


def coins_for(session):
    """
    Gold for items passed first try, silver for items passed at all. The Figma
    summary shows two coin counts side by side; this is the simplest reading of
    that which is actually derivable from what we store.
    """
    gold = silver = 0
    for attempt in session.best_attempts():
        if not attempt.passed:
            continue
        if attempt.ordinal == 1:
            gold += 1
        else:
            silver += 1
    return gold, silver
