"""Writes test/fixtures/reward-parity.json from the Python reference so the JS
port can be checked against it (scores, coins, decks, prizes, arms).

Run from the repo root:  python3 scripts/generate-reward-parity-fixture.py
"""
import json
import os
import random
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "docs", "spin_reward_handoff", "reference_python"))

from reward_logic_reference import (  # noqa: E402
    CONFIG, Features, total_score, population_params, total_coins, build_deck, prizes_for_day, arm,
)

rng = random.Random(20260731)


def pick(values):
    return values[rng.randrange(len(values))]


def random_features(user_id):
    # Values sit on and around every factor boundary in SPEC §3.
    n = pick([2, 3, 4, 5, 9, 10, 15])
    minutes = pick([0, 0, 5, 14.9, 15, 59.9, 60, 179.9, 180, 400])
    last_minutes = pick([0, 0, 10, minutes, minutes / 1.2, minutes / 0.8, minutes * 2])
    return Features(
        user_id=user_id,
        recharges_30d=n,
        median_recharge_rs=pick([30, 49.99, 50, 62, 149, 150, 251, 499, 500, 1999]),
        days_since_last_recharge=pick([0.1, 0.5, 1, 2, 3, 5, 8, 20]),
        usual_gap_days=pick([0.2, 0.5, 1, 2, 4, 10]),
        last_pack_coins=pick([None, 80, 300, 450, 1100]),
        prev_pack_coins=pick([None, 80, 300, 450, 1100]),
        offer_share=pick([0, 0.2, 0.25, 0.5, 0.75, 0.8, 1]),
        minutes_this_week=minutes,
        minutes_last_week=last_minutes,
        video_minutes_this_week=pick([0, minutes * 0.1, minutes * 0.25, minutes * 0.49, minutes * 0.5, minutes]),
        max_calls_same_listener=pick([0, 1, 2, 3, 7]),
        unfinished_payment_attempts=pick([0, 1, 2, 5]),
        ran_out_calls=pick([0, 1, 2, 4]),
        is_ios=pick([True, False]),
        is_international=pick([True, False]),
        account_age_days=pick([10, 89, 90, 400]),
    )


users = [random_features(100000 + i) for i in range(500)]
scored = [{"features": vars(f), "score": total_score(f)} for f in users]
scores = [s["score"]["total"] for s in scored]
params = population_params(scores)
for s in scored:
    s["total_coins"] = total_coins(s["score"]["total"], params)

decks = {}
for total in range(CONFIG["min_coins"], CONFIG["max_coins"] + 1, 5):
    days = build_deck(total)
    decks[total] = {"days": days, "prizes": [prizes_for_day(d) for d in days]}

fixture = {
    "population": {
        "median_score": params["median_score"],
        "coins_per_share": params["coins_per_share"],
        "budget_coins": params["budget_coins"],
    },
    "users": scored,
    "decks": decks,
    "arms": {str(uid): arm(uid) for uid in [1, 2, 3, 42, 168768] + list(range(200000, 200300))},
}

out = os.path.join(ROOT, "test", "fixtures", "reward-parity.json")
os.makedirs(os.path.dirname(out), exist_ok=True)
with open(out, "w") as fh:
    json.dump(fixture, fh, indent=1)
print(f"wrote {out}: {len(scored)} users, median {params['median_score']}, "
      f"coins/share {params['coins_per_share']:.2f}, {len(decks)} decks")
