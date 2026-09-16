from django.contrib import admin

from .models import PetState, Purchase, ShopItem, Wallet


@admin.register(ShopItem)
class ShopItemAdmin(admin.ModelAdmin):
    list_display = ("name", "cost", "feeds_days", "order")
    prepopulated_fields = {"slug": ("name",)}


@admin.register(Wallet)
class WalletAdmin(admin.ModelAdmin):
    list_display = ("participant", "coins")


@admin.register(Purchase)
class PurchaseAdmin(admin.ModelAdmin):
    list_display = ("wallet", "shop_item", "cost_paid", "created_at")


@admin.register(PetState)
class PetStateAdmin(admin.ModelAdmin):
    list_display = ("participant", "fed_until", "is_hungry")
