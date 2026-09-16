"""
Import the shipped phrase curriculum into the database.

Reads `docs/multi-syllable/phrases.js` through Node rather than re-parsing it
in Python: that file is the real source of truth, its `surfaceTones` are
human-reviewed sandhi output, and a second parser would be a second thing that
can drift. If Node isn't available the command fails loudly rather than
silently importing a guess.
"""

import json
import subprocess

from django.core.management.base import BaseCommand, CommandError
from django.db import transaction

from curriculum.models import Course, Item, ItemSyllable, Lesson

NODE_SNIPPET = (
    "import({src}).then(m => "
    "process.stdout.write(JSON.stringify(m.PHRASES)))"
)


class Command(BaseCommand):
    help = "Import docs/multi-syllable/phrases.js into a Course/Lesson."

    def add_arguments(self, parser):
        parser.add_argument("--course", default="engine-phrases", help="Course slug.")
        parser.add_argument("--lesson", default="shipped-phrases", help="Lesson slug.")
        parser.add_argument("--lesson-number", type=int, default=99)
        parser.add_argument("--title", default="Shipped phrases")

    def handle(self, *args, **options):
        from django.conf import settings

        src = settings.REPO_ROOT / "docs" / "multi-syllable" / "phrases.js"
        if not src.exists():
            raise CommandError(f"{src} not found")

        try:
            proc = subprocess.run(
                ["node", "-e", NODE_SNIPPET.format(src=json.dumps(str(src)))],
                capture_output=True,
                text=True,
                check=True,
            )
        except FileNotFoundError as exc:
            raise CommandError("node is required to read phrases.js") from exc
        except subprocess.CalledProcessError as exc:
            raise CommandError(f"node failed reading phrases.js:\n{exc.stderr}") from exc

        phrases = json.loads(proc.stdout)

        with transaction.atomic():
            course, _ = Course.objects.get_or_create(
                slug=options["course"], defaults={"name": "Engine phrase set"}
            )
            lesson, _ = Lesson.objects.update_or_create(
                slug=options["lesson"],
                defaults={
                    "course": course,
                    "number": options["lesson_number"],
                    "title": options["title"],
                },
            )

            for order, phrase in enumerate(phrases):
                item, _ = Item.objects.update_or_create(
                    lesson=lesson,
                    slug=phrase["id"],
                    defaults={
                        "kind": Item.Kind.WORD if len(phrase["syllables"]) <= 2 else Item.Kind.SENTENCE,
                        "order": order,
                        "hanzi": phrase["hanzi"],
                        "gloss": phrase.get("gloss", ""),
                        "note": phrase.get("note", "") or "",
                    },
                )
                item.syllables.all().delete()
                accepted = phrase.get("acceptedTones") or []
                for i, syl in enumerate(phrase["syllables"]):
                    ItemSyllable.objects.create(
                        item=item,
                        order=i,
                        pinyin=syl["pinyin"],
                        surface_pinyin=syl.get("surfacePinyin", "") or "",
                        alt_pinyin=syl.get("altPinyin", "") or "",
                        base=syl["base"],
                        tone=syl["tone"],
                        surface_tone=phrase["surfaceTones"][i],
                        accepted_tones=accepted[i] if i < len(accepted) else [],
                        morph=syl.get("morph", "") or "",
                    )
                item.refresh_phrase_json()

        self.stdout.write(
            self.style.SUCCESS(f"Imported {len(phrases)} phrases into {lesson}.")
        )
