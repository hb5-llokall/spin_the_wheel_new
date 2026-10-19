-- Reward engine v1: recharge segment and scoring features of every Dostt user
-- who recharged in [S-29, S] (S = scoring date, IST).
-- Save in Redash on the "BigQuery - Dostt" data source with one Date parameter
-- named scoring_date, and set REDASH_REWARD_FEATURES_QUERY_ID to its id.
-- The nightly job passes S = yesterday (IST).
--
-- The app keeps only users who spun the wheel in [S-6, S] (from the game's own
-- spin_events), so a payer who comes back after a break is scored the next
-- night. Users not in this result have 0 recharges (unpaid).
-- recharges_30d decides the segment (2+ regular payer, 1 one-time payer); the
-- other features are only used for regular payers. Scoring happens in the app
-- (src/reward-logic.js), not here.
--
-- Same definitions as docs/spin_reward_handoff/reference_sql/rewards_per_user_same_budget_bq.sql,
-- except: rolling windows ([S-29, S] for money instead of the calendar month), an
-- exact median recharge (PERCENTILE_CONT, as Python's median), and only real
-- gateway payments in INR count as recharges (as the older recharge query).

WITH params AS (
  SELECT
    DATE '{{ scoring_date }}'                                                   AS s,
    TIMESTAMP(DATE_SUB(DATE '{{ scoring_date }}', INTERVAL 29 DAY), 'Asia/Kolkata') AS money_from,
    TIMESTAMP(DATE_SUB(DATE '{{ scoring_date }}', INTERVAL 6 DAY), 'Asia/Kolkata')  AS week_from,
    TIMESTAMP(DATE_ADD(DATE '{{ scoring_date }}', INTERVAL 1 DAY), 'Asia/Kolkata')  AS until
),
-- payments_order.customer_id and bookings_booking.customer_id are
-- customers_customer ids; the wheel knows users by their users_user id
-- (customers_customer.user_id). Checked 2026-10-19: id never equals user_id.
customer_map AS (
  SELECT id AS customer_id, user_id
  FROM `dostt-c1d96.dostt_pg_datastream_us.public_customers_customer`
),

/* ---------------- MONEY: recharges in [S-29, S] ---------------- */
recharges AS (
  SELECT
    cm.user_id,
    o.finalised_on,
    CAST(o.amount AS FLOAT64) AS amount,
    o.coins,
    o.offer_id,
    ROW_NUMBER() OVER (PARTITION BY cm.user_id ORDER BY o.finalised_on DESC) AS rn,
    PERCENTILE_CONT(CAST(o.amount AS FLOAT64), 0.5) OVER (PARTITION BY cm.user_id) AS median_amount
  FROM `dostt-c1d96.dostt_pg_datastream_us.public_payments_order` o
  JOIN customer_map cm ON cm.customer_id = o.customer_id
  CROSS JOIN params p
  WHERE o.type = 1                 -- RECHARGE
    AND o.status = 1               -- PAID
    AND o.payment_gateway <> 0     -- real gateway payment
    AND o.amount > 0
    AND o.currency = 'INR'
    AND o.finalised_on >= p.money_from
    AND o.finalised_on <  p.until
),
money AS (
  SELECT
    r.user_id,
    COUNT(*)                                      AS recharges_30d,
    ANY_VALUE(r.median_amount)                    AS median_recharge_rs,
    MIN(r.finalised_on)                           AS first_ts,
    MAX(r.finalised_on)                           AS last_ts,
    MAX(IF(r.rn = 1, r.coins, NULL))              AS last_pack_coins,
    MAX(IF(r.rn = 2, r.coins, NULL))              AS prev_pack_coins,
    AVG(IF(r.offer_id IS NOT NULL, 1.0, 0.0))     AS offer_share
  FROM recharges r
  GROUP BY 1
),

/* ---------------- CALLS (ETL booking_talktime, connected calls) ---------------- */
-- booking_talktime.user_id is a customers_customer id (checked 2026-10-19:
-- matches bookings_booking.customer_id), so it is mapped like the others.
talk AS (
  SELECT
    cm.user_id,
    t.expert_id,
    DATE(t.booked_at_ist)                       AS call_date,
    IFNULL(t.talktime_sec, 0)       / 60.0      AS minutes,
    IFNULL(t.talktime_sec_video, 0) / 60.0      AS video_minutes
  FROM `dostt-c1d96.aggregate_tables.booking_talktime` t
  JOIN customer_map cm ON cm.customer_id = t.user_id
  CROSS JOIN params p
  WHERE t.booked_at_ist >= DATETIME(DATE_SUB(p.s, INTERVAL 13 DAY))
    AND t.booked_at_ist <  DATETIME(DATE_ADD(p.s, INTERVAL 1 DAY))
    AND cm.user_id IN (SELECT user_id FROM money WHERE recharges_30d >= 2)
),
call_agg AS (
  SELECT
    t.user_id,
    SUM(IF(t.call_date >= DATE_SUB(p.s, INTERVAL 6 DAY), t.minutes, 0))       AS minutes_this_week,
    SUM(IF(t.call_date <  DATE_SUB(p.s, INTERVAL 6 DAY), t.minutes, 0))       AS minutes_last_week,
    SUM(IF(t.call_date >= DATE_SUB(p.s, INTERVAL 6 DAY), t.video_minutes, 0)) AS video_minutes_this_week
  FROM talk t, params p
  GROUP BY 1
),
repeat_listener AS (
  SELECT user_id, MAX(n) AS max_calls_same_listener
  FROM (
    SELECT t.user_id, t.expert_id, COUNT(*) AS n
    FROM talk t, params p
    WHERE t.call_date >= DATE_SUB(p.s, INTERVAL 6 DAY)
    GROUP BY 1, 2
  )
  GROUP BY 1
),

/* ---------------- WALLET: connected calls that ended out of coins, [S-6, S] ---------------- */
ran_out AS (
  SELECT cm.user_id, COUNT(*) AS ran_out_calls
  FROM `dostt-c1d96.dostt_pg_datastream_us.public_bookings_booking` b
  JOIN customer_map cm ON cm.customer_id = b.customer_id
  CROSS JOIN params p
  WHERE b.booked_at >= p.week_from
    AND b.booked_at <  p.until
    AND b.started_at IS NOT NULL
    AND b.ended_at > b.started_at
    AND b.final_customer_balance < b.coins_per_minute
    AND cm.user_id IN (SELECT user_id FROM money WHERE recharges_30d >= 2)
  GROUP BY 1
),

/* ---------------- SHOPPING: unfinished recharge attempts, [S-6, S] ---------------- */
attempts AS (
  SELECT cm.user_id, COUNT(*) AS unfinished_payment_attempts
  FROM `dostt-c1d96.dostt_pg_datastream_us.public_payments_order` o
  JOIN customer_map cm ON cm.customer_id = o.customer_id
  CROSS JOIN params p
  WHERE o.type = 1
    AND o.status IN (0, 2, 3, 4)
    AND o.initiated_date BETWEEN DATE_SUB(p.s, INTERVAL 6 DAY) AND p.s
    AND cm.user_id IN (SELECT user_id FROM money WHERE recharges_30d >= 2)
  GROUP BY 1
),

/* ---------------- PROFILE (ETL user_info; user_id is the users_user id, checked 2026-10-19) ---------------- */
profile AS (
  SELECT
    ui.user_id,
    ui.platform_onboarded,
    ui.country_onboarded,
    DATE_DIFF(p.s, DATE(ui.first_login_at), DAY) AS account_age_days
  FROM `dostt-c1d96.aggregate_tables.user_info` ui, params p
  WHERE ui.user_id IN (SELECT user_id FROM money WHERE recharges_30d >= 2)
)

SELECT
  m.user_id,
  m.recharges_30d,
  m.median_recharge_rs,
  TIMESTAMP_DIFF(p.until, m.last_ts, SECOND) / 86400.0                              AS days_since_last_recharge,
  IF(m.recharges_30d >= 2,
     GREATEST(TIMESTAMP_DIFF(m.last_ts, m.first_ts, SECOND) / 86400.0 / (m.recharges_30d - 1), 0.5),
     NULL)                                                                          AS usual_gap_days,
  m.last_pack_coins,
  m.prev_pack_coins,
  m.offer_share,
  IFNULL(c.minutes_this_week, 0)                                                    AS minutes_this_week,
  IFNULL(c.minutes_last_week, 0)                                                    AS minutes_last_week,
  IFNULL(c.video_minutes_this_week, 0)                                              AS video_minutes_this_week,
  IFNULL(rl.max_calls_same_listener, 0)                                             AS max_calls_same_listener,
  IFNULL(att.unfinished_payment_attempts, 0)                                        AS unfinished_payment_attempts,
  IFNULL(r.ran_out_calls, 0)                                                        AS ran_out_calls,
  pr.platform_onboarded,
  pr.country_onboarded,
  pr.account_age_days
FROM money m
CROSS JOIN params p
LEFT JOIN call_agg c         ON c.user_id  = m.user_id
LEFT JOIN repeat_listener rl ON rl.user_id = m.user_id
LEFT JOIN ran_out r          ON r.user_id  = m.user_id
LEFT JOIN attempts att       ON att.user_id = m.user_id
LEFT JOIN profile pr         ON pr.user_id = m.user_id
ORDER BY m.user_id;
