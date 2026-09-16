"""
Demo data: the two lessons the Figma comps actually show, a cohort, a student,
and the shop's tiger food. Enough to click through every screen.

The vocabulary and sentences are transcribed from the "Today's Lesson" frame.
Surface tones are set explicitly rather than computed, matching the
authoring-time discipline in phrases.js — note 你好 is not in this lesson, so
no T3+T3 sandhi arises in the sentences here.
"""

from datetime import timedelta

from django.contrib.auth.models import User
from django.core.management.base import BaseCommand
from django.db import transaction
from django.utils import timezone

from curriculum.models import Course, Item, ItemSyllable, Lesson
from practice.models import ItemAttempt, PracticeSession, SessionMode
from rewards.models import ShopItem, Wallet
from study.models import Cohort, LessonAssignment, Participant

# words:     (slug, hanzi, gloss,  [(pinyin, base, tone), ...])
# sentences: (slug, hanzi, pinyin, [...])
LESSON_2_WORDS = [
    ("ni", "你", "you", [("nǐ", "ni", 3)]),
    ("hao", "好", "good", [("hǎo", "hao", 3)]),
    ("qing", "请", "please", [("qǐng", "qing", 3)]),
    ("wen", "问", "ask", [("wèn", "wen", 4)]),
    ("gui", "贵", "expensive", [("guì", "gui", 4)]),
    ("xing", "姓", "surname", [("xìng", "xing", 4)]),
    ("wo", "我", "I; me", [("wǒ", "wo", 3)]),
    ("ne", "呢", "question participle", [("ne", "ne", 0)]),
    ("jiao", "叫", "to call", [("jiào", "jiao", 4)]),
    ("shenme", "什么", "what", [("shén", "shen", 2), ("me", "me", 0)]),
    ("mingzi", "名字", "name", [("míng", "ming", 2), ("zi", "zi", 0)]),
]

LESSON_2_SENTENCES = [
    (
        "ni-jiao-shenme-mingzi",
        "你叫什么名字？",
        "Nǐ jiào shénme míngzi?",
        [("nǐ", "ni", 3), ("jiào", "jiao", 4), ("shén", "shen", 2),
         ("me", "me", 0), ("míng", "ming", 2), ("zi", "zi", 0)],
    ),
    (
        "qing-wen-ni-gui-xing",
        "请问，你贵姓？",
        "Qǐng wèn, nǐ guì xìng?",
        [("qǐng", "qing", 3), ("wèn", "wen", 4), ("nǐ", "ni", 3),
         ("guì", "gui", 4), ("xìng", "xing", 4)],
    ),
]

LESSON_1_WORDS = [
    ("lao-shi", "老师", "teacher", [("lǎo", "lao", 3), ("shī", "shi", 1)]),
    ("xue-sheng", "学生", "student", [("xué", "xue", 2), ("shēng", "sheng", 1)]),
    ("zhong-guo", "中国", "China", [("zhōng", "zhong", 1), ("guó", "guo", 2)]),
    ("mei-guo", "美国", "USA", [("měi", "mei", 3), ("guó", "guo", 2)]),
]

SHOP = [
    ("river-fish", "River Fish", 12, 5, "Keeps your tiger fed for 5 days"),
    ("salmon", "Salmon", 10, 10, "Keeps your tiger fed for 10 days"),
    ("tuna", "Tuna", 20, 7, "Keeps your tiger fed for 7 days"),
]


def make_item(lesson, kind, order, slug, hanzi, gloss, syllables, pinyin=""):
    item, _ = Item.objects.update_or_create(
        lesson=lesson,
        slug=slug,
        defaults={
            "kind": kind, "order": order, "hanzi": hanzi,
            "gloss": gloss, "pinyin_override": pinyin,
        },
    )
    item.syllables.all().delete()
    for i, (pinyin, base, tone) in enumerate(syllables):
        ItemSyllable.objects.create(
            item=item, order=i, pinyin=pinyin, base=base, tone=tone, surface_tone=tone
        )
    item.refresh_phrase_json()
    return item


class Command(BaseCommand):
    help = "Create the demo course, lessons, student, and shop items."

    @transaction.atomic
    def handle(self, *args, **options):
        course, _ = Course.objects.get_or_create(
            slug="mandarin-1", defaults={"name": "Mandarin 1"}
        )

        lesson1, _ = Lesson.objects.update_or_create(
            slug="introductions",
            defaults={"course": course, "number": 1, "title": "Introductions"},
        )
        lesson2, _ = Lesson.objects.update_or_create(
            slug="exchanging-greetings",
            defaults={"course": course, "number": 2, "title": "Exchanging Greetings"},
        )
        for n, title in ((3, "Lesson 3 Title"), (4, "Lesson 4 Title"), (5, "Lesson 5 Title")):
            Lesson.objects.update_or_create(
                slug=f"lesson-{n}", defaults={"course": course, "number": n, "title": title}
            )

        for order, (slug, hanzi, gloss, syls) in enumerate(LESSON_1_WORDS):
            make_item(lesson1, Item.Kind.WORD, order, slug, hanzi, gloss, syls)
        for order, (slug, hanzi, gloss, syls) in enumerate(LESSON_2_WORDS):
            make_item(lesson2, Item.Kind.WORD, order, slug, hanzi, gloss, syls)
        for order, (slug, hanzi, pinyin, syls) in enumerate(LESSON_2_SENTENCES):
            # Sentences carry authored pinyin: a syllable join cannot know word
            # boundaries (shénme, not "shén me").
            make_item(lesson2, Item.Kind.SENTENCE, order, slug, hanzi, "", syls, pinyin=pinyin)

        teacher, created = User.objects.get_or_create(
            username="teacher", defaults={"is_staff": True, "is_superuser": True}
        )
        if created:
            teacher.set_password("tonetiger")
            teacher.save()

        cohort, _ = Cohort.objects.get_or_create(
            name="Period 3", defaults={"course": course, "instructor": teacher}
        )

        student, created = User.objects.get_or_create(
            username="student", defaults={"first_name": "Sam"}
        )
        if created:
            student.set_password("tonetiger")
            student.save()

        participant, _ = Participant.objects.get_or_create(
            user=student,
            defaults={"cohort": cohort, "study_id": "P001", "condition": "treatment"},
        )
        Wallet.objects.get_or_create(participant=participant, defaults={"coins": 27})

        today = timezone.localdate()
        LessonAssignment.objects.update_or_create(
            cohort=cohort,
            lesson=lesson2,
            mode=SessionMode.PRACTICE,
            defaults={"available_on": today},
        )
        LessonAssignment.objects.update_or_create(
            cohort=cohort,
            lesson=lesson1,
            mode=SessionMode.PRACTICE,
            defaults={"available_on": today - timedelta(days=1)},
        )

        # A finished lesson-1 session yesterday, so the dashboard's
        # "Yesterday's Lesson" card and the history table have something real.
        if not PracticeSession.objects.filter(
            participant=participant, lesson=lesson1
        ).exists():
            yesterday = timezone.now() - timedelta(days=1)
            session = PracticeSession.objects.create(
                participant=participant, lesson=lesson1, mode=SessionMode.PRACTICE
            )
            PracticeSession.objects.filter(pk=session.pk).update(
                started_at=yesterday, ended_at=yesterday + timedelta(minutes=14, seconds=26)
            )
            session.refresh_from_db()
            for item in lesson1.items.all():
                ItemAttempt.objects.create(
                    session=session, item=item, ordinal=1, voiced=True,
                    verdict="good", passed=True, duration_sec=0.9,
                    payload={"phraseId": item.slug, "syllables": [], "seeded": True},
                )
            session.recompute_score()
            session.completed = True
            session.coins_earned = lesson1.items.count()
            session.save(update_fields=["score", "completed", "coins_earned"])

        for order, (slug, name, cost, days, desc) in enumerate(SHOP):
            ShopItem.objects.update_or_create(
                slug=slug,
                defaults={
                    "name": name, "cost": cost, "feeds_days": days,
                    "description": desc, "order": order,
                },
            )

        self.stdout.write(self.style.SUCCESS(
            "Seeded. Log in as student/tonetiger (or teacher/tonetiger for admin)."
        ))
