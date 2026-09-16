"""Chrome shared by every page: who is signed in, and their coin balance."""

from rewards.models import Wallet


def chrome(request):
    participant = None
    coins = 0
    user = getattr(request, "user", None)
    if user is not None and user.is_authenticated:
        participant = getattr(user, "participant", None)
        if participant is not None:
            wallet = Wallet.objects.filter(participant=participant).first()
            coins = wallet.coins if wallet else 0
    return {
        "participant": participant,
        "coin_balance": coins,
        "site_name": "Tone Tiger",
    }
