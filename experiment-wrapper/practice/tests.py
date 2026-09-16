"""
End-to-end cover for the wrapper's half of the contract: a component `attempt`
payload goes in, rows and a verdict come out, the fail-twice rule holds, and
test mode hides the tone marks without changing what is graded.
"""

import json

from django.contrib.auth.models import User
from django.test import TestCase
from django.urls import reverse
from django.utils import timezone

from curriculum.models import Course, Item, ItemSyllable, Lesson
from curriculum.pinyin import strip_tone_marks
from study.models import Cohort, LessonAssignment, Participant

from .models import ItemAttempt, PracticeSession, SessionMode, SyllableAttempt


def attempt_payload(verdict="bad", best_tone=2, diagnostic="Tone 3 drops — go further down."):
    """The shape buildAttemptDetail() emits, for a one-syllable T3 item."""
    return {
        "phraseId": "ni",
        "hanzi": "你",
        "citationTones": [3],
        "surfaceTones": [3],
        "voiced": True,
        "reason": None,
        "segmentationMethod": "guided",
        "registerTrusted": True,
        "durationSec": 0.82,
        "syllables": [
            {
                "index": 0, "pinyin": "nǐ", "citationPinyin": "nǐ", "base": "ni",
                "citationTone": 3, "surfaceTone": 3, "acceptedTones": [3],
                "optional": False, "matchedTone": 3 if verdict == "good" else None,
                "sandhi": False, "neutral": False, "voiced": True, "reason": None,
                "verdict": verdict, "targetScore": 0.91 if verdict == "good" else 0.21,
                "bestTone": best_tone, "scores": {"1": 0.1, "2": 0.6, "3": 0.21, "4": 0.09},
                "diagnostic": diagnostic, "coefs": [1.2, -0.4, 0.3, 0.05],
            }
        ],
        "aggregate": {
            "scored": 1, "good": 1 if verdict == "good" else 0, "close": 0,
            "bad": 0 if verdict == "good" else 1, "uncertain": 0, "neutral": 0,
        },
    }


class PracticeFlowTests(TestCase):
    def setUp(self):
        self.course = Course.objects.create(name="Mandarin 1", slug="mandarin-1")
        self.lesson = Lesson.objects.create(
            course=self.course, number=2, slug="greetings", title="Exchanging Greetings"
        )
        self.item = Item.objects.create(
            lesson=self.lesson, slug="ni", hanzi="你", gloss="you", order=0
        )
        ItemSyllable.objects.create(
            item=self.item, order=0, pinyin="nǐ", base="ni", tone=3, surface_tone=3
        )
        self.item.refresh_phrase_json()

        teacher = User.objects.create_user("teacher")
        self.cohort = Cohort.objects.create(
            name="Period 3", course=self.course, instructor=teacher
        )
        self.user = User.objects.create_user("student", password="pw")
        self.participant = Participant.objects.create(
            user=self.user, cohort=self.cohort, study_id="P001"
        )
        self.client.login(username="student", password="pw")

    def start(self, mode=SessionMode.PRACTICE):
        response = self.client.get(
            reverse("start_session", args=[self.lesson.slug]) + f"?mode={mode}"
        )
        return PracticeSession.objects.get(pk=response.headers["Location"].split("/")[2])

    # -- phrase contract ---------------------------------------------------

    def test_phrase_json_matches_component_shape(self):
        phrase = self.item.phrase_json
        self.assertEqual(phrase["id"], "ni")
        self.assertEqual(phrase["surfaceTones"], [3])
        self.assertEqual(phrase["syllables"][0]["base"], "ni")
        # acceptedTones is present ONLY when a position is optional.
        self.assertNotIn("acceptedTones", phrase)

    def test_practice_mode_keeps_tone_marks(self):
        session = self.start(SessionMode.PRACTICE)
        config = self.client.get(
            reverse("practice_run", args=[session.id])
        ).context["config"]
        self.assertTrue(config["showToneMarks"])
        self.assertEqual(config["phrases"][0]["syllables"][0]["pinyin"], "nǐ")

    def test_test_mode_strips_tone_marks_but_not_grading_data(self):
        LessonAssignment.objects.create(
            cohort=self.cohort, lesson=self.lesson,
            mode=SessionMode.TEST, available_on=timezone.localdate(),
        )
        session = self.start(SessionMode.TEST)
        config = self.client.get(
            reverse("practice_run", args=[session.id])
        ).context["config"]
        syllable = config["phrases"][0]["syllables"][0]
        self.assertFalse(config["showToneMarks"])
        self.assertEqual(syllable["pinyin"], "ni")        # mark gone
        self.assertEqual(syllable["tone"], 3)             # grading untouched
        self.assertEqual(config["phrases"][0]["surfaceTones"], [3])

    def test_vocabulary_is_sequenced_before_sentences(self):
        sentence = Item.objects.create(
            lesson=self.lesson, slug="s1", hanzi="你好吗？",
            kind=Item.Kind.SENTENCE, order=0,
        )
        ItemSyllable.objects.create(
            item=sentence, order=0, pinyin="nǐ", base="ni", tone=3, surface_tone=3
        )
        sentence.refresh_phrase_json()
        self.assertEqual(
            [i.slug for i in self.lesson.items.all()], ["ni", "s1"]
        )

    def test_test_mode_is_day_of_only(self):
        response = self.client.get(
            reverse("start_session", args=[self.lesson.slug]) + "?mode=test"
        )
        self.assertEqual(response.status_code, 404)

    # -- attempts ----------------------------------------------------------

    def post_attempt(self, session, payload):
        return self.client.post(
            reverse("submit_attempt", args=[session.id]),
            data=json.dumps({"itemId": self.item.id, "detail": payload}),
            content_type="application/json",
        )

    def test_attempt_persists_payload_and_flattened_syllables(self):
        session = self.start()
        response = self.post_attempt(session, attempt_payload("bad"))
        self.assertEqual(response.status_code, 200)

        attempt = ItemAttempt.objects.get()
        self.assertEqual(attempt.verdict, "bad")
        self.assertFalse(attempt.passed)
        self.assertEqual(attempt.segmentation_method, "guided")
        # Raw payload kept verbatim for re-analysis...
        self.assertEqual(attempt.payload["syllables"][0]["scores"]["2"], 0.6)
        # ...and flattened for querying.
        syllable = SyllableAttempt.objects.get()
        self.assertEqual(syllable.surface_tone, 3)
        self.assertEqual(syllable.best_tone, 2)
        self.assertEqual(syllable.coefs, [1.2, -0.4, 0.3, 0.05])

    def test_first_failure_returns_advice_and_does_not_advance(self):
        session = self.start()
        body = self.post_attempt(session, attempt_payload("bad")).json()
        self.assertEqual(body["label"], "Try Again")
        self.assertFalse(body["passed"])
        self.assertFalse(body["advance"])
        self.assertIn("Tone 3 drops", body["diagnostic"])
        self.assertEqual(body["attemptsRemaining"], 1)

    def test_second_failure_advances_anyway(self):
        session = self.start()
        self.post_attempt(session, attempt_payload("bad"))
        body = self.post_attempt(session, attempt_payload("bad")).json()
        self.assertTrue(body["advance"])
        self.assertEqual(body["attemptsRemaining"], 0)

    def test_third_attempt_is_refused(self):
        session = self.start()
        self.post_attempt(session, attempt_payload("bad"))
        self.post_attempt(session, attempt_payload("bad"))
        response = self.post_attempt(session, attempt_payload("good"))
        self.assertEqual(response.status_code, 409)
        self.assertEqual(ItemAttempt.objects.count(), 2)

    def test_passing_verdict_is_rederived_server_side(self):
        """A client claiming success cannot make a `bad` payload pass."""
        session = self.start()
        payload = attempt_payload("bad")
        payload["passed"] = True          # client lies
        payload["aggregate"]["good"] = 1
        self.post_attempt(session, payload)
        self.assertFalse(ItemAttempt.objects.get().passed)

    def test_close_does_not_pass(self):
        session = self.start()
        body = self.post_attempt(session, attempt_payload("close")).json()
        self.assertEqual(body["label"], "Almost")
        self.assertFalse(body["passed"])

    # -- completion --------------------------------------------------------

    def test_finish_scores_session_and_banks_coins(self):
        session = self.start()
        self.post_attempt(session, attempt_payload("good"))
        response = self.client.post(reverse("finish_session", args=[session.id]))
        self.assertEqual(response.status_code, 200)

        session.refresh_from_db()
        self.assertTrue(session.completed)
        self.assertEqual(session.score, 1.0)
        self.assertEqual(session.coins_earned, 1)      # gold: passed first try
        self.participant.refresh_from_db()
        self.assertEqual(self.participant.wallet.coins, 1)
        self.assertEqual(
            self.participant.progress.get().status, "completed"
        )

    def test_finish_is_idempotent(self):
        session = self.start()
        self.post_attempt(session, attempt_payload("good"))
        self.client.post(reverse("finish_session", args=[session.id]))
        self.client.post(reverse("finish_session", args=[session.id]))
        self.participant.refresh_from_db()
        self.assertEqual(self.participant.wallet.coins, 1)

    def test_summary_and_history_render(self):
        session = self.start()
        self.post_attempt(session, attempt_payload("good"))
        self.client.post(reverse("finish_session", args=[session.id]))
        for name in ("session_done", "session_summary"):
            self.assertEqual(
                self.client.get(reverse(name, args=[session.id])).status_code, 200
            )
        self.assertEqual(self.client.get(reverse("history")).status_code, 200)


class ToneMarkTests(TestCase):
    def test_strip_tone_marks_keeps_umlaut(self):
        self.assertEqual(strip_tone_marks("nǐ"), "ni")
        self.assertEqual(strip_tone_marks("hǎo"), "hao")
        self.assertEqual(strip_tone_marks("shénme"), "shenme")
        # ü is a vowel quality, not a tone mark, and must survive.
        self.assertEqual(strip_tone_marks("lǜ"), "lü")
        self.assertEqual(strip_tone_marks("nǚ"), "nü")


class ScoringTests(TestCase):
    def test_neutral_syllables_are_excluded_from_the_verdict(self):
        from .scoring import worst_verdict

        syllables = [
            {"verdict": "good", "neutral": False},
            {"verdict": "bad", "neutral": True},     # neutral is unscored
        ]
        self.assertEqual(worst_verdict(syllables), "good")

    def test_worst_scored_syllable_decides_the_item(self):
        from .scoring import worst_verdict

        syllables = [
            {"verdict": "good", "neutral": False},
            {"verdict": "close", "neutral": False},
        ]
        self.assertEqual(worst_verdict(syllables), "close")


class ToneBreakdownTests(TestCase):
    def test_absent_tone_reports_none_not_zero(self):
        """A lesson with no T1 must not read as 0% on tone 1."""
        from .scoring import tone_breakdown

        rows = {r["tone"]: r for r in tone_breakdown([])}
        self.assertIsNone(rows[1]["pct"])
        self.assertEqual(rows[1]["scored"], 0)
