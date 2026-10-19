import csv, os
from reward_logic_reference import (CONFIG, share, total_coins, build_deck, prizes_for_day,
                                    REPRESENTABLE, population_params, day_cards, arm)

HERE = os.path.dirname(__file__)

def test_golden_share_and_coins():
    path = os.path.join(HERE, "..", "examples", "golden_share_and_coins.csv")
    for r in csv.DictReader(open(path)):
        s, med = float(r["total_score"]), float(r["median_score"])
        assert abs(share(s, med) - float(r["expected_share"])) < 1e-3
        params = {"median_score": med, "coins_per_share": float(r["coins_per_share"])}
        assert total_coins(s, params) == int(r["expected_total_coins"])

def test_median_gets_most():
    params = {"median_score": 46, "coins_per_share": 131}
    top = total_coins(46, params)
    assert all(total_coins(s, params) <= top for s in range(0, 101))

def test_lower_side_gets_more_than_higher_side_at_same_distance():
    for d in range(1, 46):
        assert share(46 - d, 46) >= share(46 + d, 46)

def test_budget_neutral_population():
    scores = [10]*50 + [30]*120 + [46]*200 + [55]*150 + [70]*40 + [90]*5
    p = population_params(scores)
    given = sum(total_coins(s, p) for s in scores)
    assert abs(given / p["budget_coins"] - 1) < 0.03     # within 3% (rounding/min/max)

def test_deck_all_totals():
    for total in range(CONFIG["min_coins"], CONFIG["max_coins"] + 1, 5):
        days = build_deck(total)
        assert len(days) == 5
        assert all(d in REPRESENTABLE for d in days)
        assert 0 <= total - sum(days) <= 5
        for d in days:
            assert sum(prizes_for_day(d)) == d and len(prizes_for_day(d)) <= 3

def test_cards_are_stable():
    assert day_cards(45, "plan-1", 3) == day_cards(45, "plan-1", 3)
    assert sorted(c for c in day_cards(45, "plan-1", 3) if c != "BETTER_LUCK") == [10, 15, 20]

def test_arm_is_deterministic():
    assert arm(168768) == arm(168768)
