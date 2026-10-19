"""
Reference implementation (pure functions, no I/O) of the Spin & Win reward logic
for REGULAR PAYERS. Port this into the real codebase; keep behaviour identical.

Pipeline per nightly run:
  features (per user) -> section points -> total_score
  population of scored users -> median_score + coins_per_share
  users whose plan ended tonight -> share -> total_coins -> 5-day deck -> daily cards
"""
from __future__ import annotations
import hashlib
import itertools
import random
from dataclasses import dataclass, field
from statistics import median as _median
from typing import Optional

# ----------------------------------------------------------------------------
# CONFIG (all tunable; keep in one config object / env / DB table)
# ----------------------------------------------------------------------------
CONFIG = {
    "budget_coins_per_user": 90,      # same total as today's wheel (10+10+10+10+50)
    "low_range": 96,                  # below median: share = 1 - (median - score)/96
    "low_floor": 0.2,
    "high_range": 25,                 # above median: share = 1 - (score - median)/25
    "high_floor": 0.1,
    "min_coins": 10,
    "max_coins": 600,
    "round_to": 5,
    "deck_weights": [0.10, 0.15, 0.20, 0.25],   # day 5 gets the rest
    "prizes": [10, 15, 20, 50],                 # winnable prizes in regular plans
    "max_wins_per_day": 3,
    "plan_days": 5,
}

# ----------------------------------------------------------------------------
# 1. FEATURES (computed from DB; IST dates; S = scoring date)
# ----------------------------------------------------------------------------
@dataclass
class Features:
    user_id: int
    recharges_30d: int                 # type=1, status=1, amount>0, finalised in [S-29, S]
    median_recharge_rs: float          # median amount (ex-GST) of those recharges
    days_since_last_recharge: float    # from last recharge to end of S
    usual_gap_days: float              # (last - first) / (n - 1), min 0.5
    last_pack_coins: Optional[int]
    prev_pack_coins: Optional[int]
    offer_share: float                 # share of recharges with offer_id not null
    minutes_this_week: float           # connected talktime, [S-6, S]
    minutes_last_week: float           # connected talktime, [S-13, S-7]
    video_minutes_this_week: float     # video part only, [S-6, S]
    max_calls_same_listener: int       # max calls to one expert, [S-6, S]
    unfinished_payment_attempts: int   # type=1, status in (0,2,3,4), initiated [S-6, S]
    ran_out_calls: int                 # calls in [S-6, S] with final_balance < coins_per_minute
    is_ios: bool
    is_international: bool
    account_age_days: int

# ----------------------------------------------------------------------------
# 2. POINTS (v3 weights: Money 40, Calls 35, Shopping 15, Wallet 5, Profile 5)
# ----------------------------------------------------------------------------
def money_points(f: Features) -> int:
    aov = 3 if f.median_recharge_rs < 50 else 5 if f.median_recharge_rs < 150 else 9 if f.median_recharge_rs < 500 else 13
    n = f.recharges_30d
    freq = 11 if n >= 10 else 9 if n >= 5 else 7 if n >= 3 else 4
    ratio = f.days_since_last_recharge / max(f.usual_gap_days, 0.5)
    due = 3 if ratio < 0.5 else 8 if ratio <= 1.5 else 4 if ratio <= 3 else 0
    if f.last_pack_coins is None or f.prev_pack_coins is None:
        trend = 0
    else:
        trend = 4 if f.last_pack_coins > f.prev_pack_coins else 3 if f.last_pack_coins == f.prev_pack_coins else 0
    offer = 4 if f.offer_share < 0.25 else 3 if f.offer_share <= 0.75 else 0
    return aov + freq + due + trend + offer                       # max 40

def calls_points(f: Features) -> int:
    m = f.minutes_this_week
    minutes = 0 if m == 0 else 4 if m < 15 else 8 if m < 60 else 11 if m < 180 else 14
    if m == 0 and f.minutes_last_week == 0:
        trend = 0
    elif f.minutes_last_week == 0:
        trend = 8
    elif m >= 1.2 * f.minutes_last_week:
        trend = 8
    elif m >= 0.8 * f.minutes_last_week:
        trend = 5
    else:
        trend = 1
    v = f.video_minutes_this_week
    video = 0 if v == 0 else 3 if v < 0.25 * m else 6 if v < 0.5 * m else 7
    rep = 6 if f.max_calls_same_listener >= 3 else 3 if f.max_calls_same_listener == 2 else 0
    return minutes + trend + video + rep                          # max 35

def shopping_points(f: Features) -> int:
    a = f.unfinished_payment_attempts
    return 15 if a >= 2 else 9 if a == 1 else 0                   # max 15 (package views: not yet)

def wallet_points(f: Features) -> int:
    return 5 if f.ran_out_calls >= 2 else 0                       # max 5

def profile_points(f: Features) -> int:
    return (2 if f.is_ios else 0) + (2 if f.is_international else 0) + (1 if f.account_age_days >= 90 else 0)  # max 5

def total_score(f: Features) -> dict:
    s = {
        "money": money_points(f), "calls": calls_points(f), "shopping": shopping_points(f),
        "wallet": wallet_points(f), "profile": profile_points(f),
    }
    s["total"] = sum(s.values())
    return s

# ----------------------------------------------------------------------------
# 3. SHARE (median gets 1.0; lower side falls slowly, higher side falls fast)
# ----------------------------------------------------------------------------
def share(score: float, median_score: float, cfg=CONFIG) -> float:
    if score <= median_score:
        return max(1 - (median_score - score) / cfg["low_range"], cfg["low_floor"])
    return max(1 - (score - median_score) / cfg["high_range"], cfg["high_floor"])

# ----------------------------------------------------------------------------
# 4. BUDGET NORMALISATION (computed on the WHOLE scored population, not just tonight's users)
#    coins_per_share = (budget_per_user * N_all) / sum(shares_all)
#    -> average reward stays at 90 coins/user; total spend unchanged
# ----------------------------------------------------------------------------
def population_params(scores: list[float], cfg=CONFIG) -> dict:
    med = _median(scores)
    total_shares = sum(share(s, med, cfg) for s in scores)
    budget = cfg["budget_coins_per_user"] * len(scores)
    return {"median_score": med, "coins_per_share": budget / total_shares, "budget_coins": budget}

def total_coins(score: float, params: dict, cfg=CONFIG) -> int:
    raw = share(score, params["median_score"], cfg) * params["coins_per_share"]
    rounded = int(round(raw / cfg["round_to"]) * cfg["round_to"])
    return min(cfg["max_coins"], max(cfg["min_coins"], rounded))

# ----------------------------------------------------------------------------
# 5. 5-DAY DECK (back-loaded; every day must be makeable with <=3 prizes)
# ----------------------------------------------------------------------------
def _representable(cfg=CONFIG) -> set[int]:
    r = {0}
    for k in range(1, cfg["max_wins_per_day"] + 1):
        for combo in itertools.combinations_with_replacement(cfg["prizes"], k):
            r.add(sum(combo))
    return r

REPRESENTABLE = _representable()          # {0,10,15,...,120,150}; e.g. 95,105,125-145 NOT makeable
MAX_DAY = max(REPRESENTABLE)              # 150

def _largest_rep_leq(x: int) -> int:
    return max(v for v in REPRESENTABLE if v <= x)

def build_deck(total: int, cfg=CONFIG) -> list[int]:
    """Split total coins into 5 daily amounts; each day 0 or makeable with <=3 prizes.
    Total is preserved except at most `round_to` coins in rare edge cases."""
    days = []
    for w in cfg["deck_weights"]:
        raw = total * w
        days.append(int(raw // cfg["round_to"] * cfg["round_to"]) if raw >= cfg["min_coins"] else 0)
    days.append(total - sum(days))
    # fix from the last day backwards: push anything not makeable (or above MAX_DAY) to the previous day
    for i in range(len(days) - 1, 0, -1):
        keep = _largest_rep_leq(min(days[i], MAX_DAY))
        days[i - 1] += days[i] - keep
        days[i] = keep
    # day 1: whatever is not makeable is pushed forward to the first day that can absorb it
    keep = _largest_rep_leq(min(days[0], MAX_DAY))
    extra = days[0] - keep
    days[0] = keep
    for i in range(len(days) - 1, -1, -1):
        if extra == 0:
            break
        if days[i] + extra in REPRESENTABLE:
            days[i] += extra
            extra = 0
    return days   # if extra remains (very rare), it is dropped (<= 5 coins)

def prizes_for_day(amount: int, cfg=CONFIG) -> list[int]:
    """Fewest prizes (<=3) that sum to amount, larger prizes first."""
    if amount == 0:
        return []
    for k in range(1, cfg["max_wins_per_day"] + 1):
        for combo in itertools.combinations_with_replacement(sorted(cfg["prizes"], reverse=True), k):
            if sum(combo) == amount:
                return list(combo)
    raise ValueError(f"amount {amount} not makeable")

def day_cards(amount: int, plan_id: str, day: int, cfg=CONFIG) -> list:
    """3 cards for the day: wins + 'BETTER_LUCK', shuffled ONCE with a deterministic seed and stored."""
    wins = prizes_for_day(amount, cfg)
    cards = wins + ["BETTER_LUCK"] * (cfg["max_wins_per_day"] - len(wins))
    seed = int(hashlib.sha256(f"{plan_id}:{day}".encode()).hexdigest(), 16)
    random.Random(seed).shuffle(cards)
    return cards

# ----------------------------------------------------------------------------
# 6. EXPERIMENT ARM (deterministic; holdout keeps today's wheel)
# ----------------------------------------------------------------------------
def arm(user_id: int, holdout_pct: int = 10) -> str:
    bucket = int(hashlib.sha256(f"spin_reward_v1:{user_id}".encode()).hexdigest(), 16) % 100
    return "holdout_legacy_90" if bucket < holdout_pct else "median_low_favoured"

LEGACY_DECK = [10, 10, 10, 10, 50]   # today's wheel, used for holdout and for segments not yet scored
