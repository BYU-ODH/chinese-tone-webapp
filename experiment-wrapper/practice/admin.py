from django.contrib import admin

from .models import ItemAttempt, PracticeSession, SpeakerCalibration, SyllableAttempt


class SyllableAttemptInline(admin.TabularInline):
    model = SyllableAttempt
    extra = 0
    can_delete = False
    readonly_fields = (
        "index", "base", "pinyin", "citation_tone", "surface_tone",
        "matched_tone", "best_tone", "verdict", "target_score", "diagnostic",
    )
    fields = readonly_fields


@admin.register(PracticeSession)
class PracticeSessionAdmin(admin.ModelAdmin):
    list_display = ("id", "participant", "lesson", "mode", "started_at", "completed", "score")
    list_filter = ("mode", "completed", "lesson")
    date_hierarchy = "started_at"


@admin.register(ItemAttempt)
class ItemAttemptAdmin(admin.ModelAdmin):
    list_display = ("item", "session", "ordinal", "verdict", "passed", "created_at")
    list_filter = ("verdict", "passed", "register_trusted")
    readonly_fields = ("payload",)
    inlines = [SyllableAttemptInline]


@admin.register(SpeakerCalibration)
class SpeakerCalibrationAdmin(admin.ModelAdmin):
    list_display = ("participant", "trusted", "updated_at")
