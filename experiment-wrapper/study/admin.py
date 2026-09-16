from django.contrib import admin

from .models import Cohort, LessonAssignment, LessonProgress, Participant


@admin.register(Cohort)
class CohortAdmin(admin.ModelAdmin):
    list_display = ("name", "course", "instructor")


@admin.register(Participant)
class ParticipantAdmin(admin.ModelAdmin):
    list_display = ("study_id", "user", "cohort", "condition", "enrolled_on", "consented_at")
    list_filter = ("cohort", "condition")
    search_fields = ("study_id", "user__username")


@admin.register(LessonAssignment)
class LessonAssignmentAdmin(admin.ModelAdmin):
    list_display = ("lesson", "cohort", "mode", "available_on")
    list_filter = ("cohort", "mode", "available_on")


@admin.register(LessonProgress)
class LessonProgressAdmin(admin.ModelAdmin):
    list_display = ("participant", "lesson", "status", "best_score", "completed_at")
    list_filter = ("status", "lesson")
