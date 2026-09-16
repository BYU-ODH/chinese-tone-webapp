from django.contrib import admin
from django.contrib.auth import views as auth_views
from django.urls import path

from curriculum import views as curriculum_views
from practice import views as practice_views
from rewards import views as rewards_views
from study import views as study_views

urlpatterns = [
    path("admin/", admin.site.urls),

    path("", study_views.landing, name="landing"),
    path("dashboard/", study_views.dashboard, name="dashboard"),
    path("history/", study_views.history, name="history"),

    path(
        "accounts/login/",
        auth_views.LoginView.as_view(template_name="registration/login.html"),
        name="login",
    ),
    path("accounts/logout/", auth_views.LogoutView.as_view(), name="logout"),

    path("lessons/<slug:slug>/", curriculum_views.lesson_detail, name="lesson_detail"),
    path("lessons/<slug:slug>/start/", practice_views.start_session, name="start_session"),

    path("sessions/<uuid:session_id>/", practice_views.practice_run, name="practice_run"),
    path(
        "sessions/<uuid:session_id>/attempts/",
        practice_views.submit_attempt,
        name="submit_attempt",
    ),
    path(
        "sessions/<uuid:session_id>/finish/",
        practice_views.finish_session,
        name="finish_session",
    ),
    path("sessions/<uuid:session_id>/done/", practice_views.session_done, name="session_done"),
    path(
        "sessions/<uuid:session_id>/summary/",
        practice_views.session_summary,
        name="session_summary",
    ),

    path("shop/", rewards_views.shop, name="shop"),
    path("shop/<slug:slug>/buy/", rewards_views.buy, name="shop_buy"),
]
