"""Coins, the shop, and the tiger. Severable if the gamification scope is cut."""

from django.db import models
from django.utils import timezone


class Wallet(models.Model):
    participant = models.OneToOneField(
        "study.Participant", on_delete=models.CASCADE, related_name="wallet"
    )
    coins = models.PositiveIntegerField(default=0)

    def __str__(self):
        return f"{self.participant} · {self.coins} coins"


class ShopItem(models.Model):
    name = models.CharField(max_length=60)
    slug = models.SlugField(unique=True)
    cost = models.PositiveIntegerField()
    feeds_days = models.PositiveIntegerField(default=0)
    description = models.CharField(max_length=140, blank=True)
    order = models.PositiveIntegerField(default=0)

    class Meta:
        ordering = ["order", "cost"]

    def __str__(self):
        return f"{self.name} ({self.cost})"


class Purchase(models.Model):
    wallet = models.ForeignKey(Wallet, on_delete=models.CASCADE, related_name="purchases")
    shop_item = models.ForeignKey(ShopItem, on_delete=models.PROTECT)
    cost_paid = models.PositiveIntegerField(help_text="Price at time of purchase.")
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-created_at"]

    def __str__(self):
        return f"{self.wallet.participant} bought {self.shop_item}"


class PetState(models.Model):
    participant = models.OneToOneField(
        "study.Participant", on_delete=models.CASCADE, related_name="pet"
    )
    fed_until = models.DateTimeField(null=True, blank=True)

    def __str__(self):
        return f"tiger for {self.participant}"

    @property
    def is_hungry(self):
        return self.fed_until is None or self.fed_until < timezone.now()
