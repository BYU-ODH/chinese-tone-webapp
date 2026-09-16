from django.contrib import admin

from .models import Course, Item, ItemSyllable, Lesson


class ItemSyllableInline(admin.TabularInline):
    model = ItemSyllable
    extra = 1
    fields = (
        "order", "pinyin", "surface_pinyin", "alt_pinyin",
        "base", "tone", "surface_tone", "accepted_tones", "morph",
    )


class ItemInline(admin.TabularInline):
    model = Item
    extra = 0
    fields = ("kind", "order", "slug", "hanzi", "gloss")
    show_change_link = True


@admin.register(Course)
class CourseAdmin(admin.ModelAdmin):
    list_display = ("name", "slug")
    prepopulated_fields = {"slug": ("name",)}


@admin.register(Lesson)
class LessonAdmin(admin.ModelAdmin):
    list_display = ("number", "title", "course", "pass_threshold")
    list_filter = ("course",)
    prepopulated_fields = {"slug": ("title",)}
    inlines = [ItemInline]


@admin.register(Item)
class ItemAdmin(admin.ModelAdmin):
    list_display = ("hanzi", "slug", "kind", "lesson", "gloss", "surface_tones")
    list_filter = ("lesson", "kind")
    search_fields = ("hanzi", "slug", "gloss")
    inlines = [ItemSyllableInline]
    readonly_fields = ("phrase_json",)

    @admin.display(description="Surface tones")
    def surface_tones(self, obj):
        return "".join(str(t) for t in obj.phrase_json.get("surfaceTones", []))

    def save_related(self, request, form, formsets, change):
        """Rebuild the component-facing cache after the syllable inline saves."""
        super().save_related(request, form, formsets, change)
        form.instance.refresh_phrase_json()
