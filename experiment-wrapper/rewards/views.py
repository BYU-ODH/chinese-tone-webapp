"""The shop, where coins become tiger food."""

from datetime import timedelta

from django.contrib import messages
from django.contrib.auth.decorators import login_required
from django.db import transaction
from django.shortcuts import get_object_or_404, redirect, render
from django.utils import timezone
from django.views.decorators.http import require_POST

from .models import PetState, Purchase, ShopItem, Wallet


@login_required
def shop(request):
    participant = getattr(request.user, "participant", None)
    wallet = None
    if participant is not None:
        wallet, _ = Wallet.objects.get_or_create(participant=participant)
    return render(
        request,
        "rewards/shop.html",
        {"items": ShopItem.objects.all(), "wallet": wallet},
    )


@require_POST
@login_required
def buy(request, slug):
    participant = getattr(request.user, "participant", None)
    if participant is None:
        return redirect("shop")

    item = get_object_or_404(ShopItem, slug=slug)
    with transaction.atomic():
        wallet = Wallet.objects.select_for_update().get_or_create(participant=participant)[0]
        if wallet.coins < item.cost:
            messages.error(request, f"Not enough coins for {item.name}.")
            return redirect("shop")

        wallet.coins -= item.cost
        wallet.save(update_fields=["coins"])
        Purchase.objects.create(wallet=wallet, shop_item=item, cost_paid=item.cost)

        pet, _ = PetState.objects.get_or_create(participant=participant)
        start = pet.fed_until if pet.fed_until and pet.fed_until > timezone.now() else timezone.now()
        pet.fed_until = start + timedelta(days=item.feeds_days)
        pet.save(update_fields=["fed_until"])

    messages.success(request, f"Your tiger enjoyed the {item.name}.")
    return redirect("shop")
