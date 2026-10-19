-- Regular payers: SCORE DISTRIBUTION CURVE, VERSION 3 (BigQuery, uses ETL tables)
-- Output: one row per score -> number of users (for the bar chart)
-- Run in: Redash -> BigQuery - Dostt
-- Same users and dates as the July run (snapshot 31 Jul 2026, IST):
--   Regular payer : 2+ recharges in July (1-31 Jul)   [type 1, paid, amount > 0; no gateway filter]
--   Spin-active   : got spin coins 25-31 Jul (used only to pick users, not scored)
--   Last 7 days   : 25-31 Jul  |  Previous week : 18-24 Jul
--   rev_next7     : recharge revenue 1-7 Aug (for checking only)
--
-- ETL tables used:
--   aggregate_tables.booking_talktime -> call minutes, video minutes, repeat listener, call trend
--   aggregate_tables.user_info        -> platform, country (onboarded), signup date
-- Removed: payment_gateway filter, bookings_bookingrequestinfo
--
-- Weights v2: Money 40 | Calls 35 | Shopping 15 | Wallet 5 | Profile 5 | Spin 0  = 100

WITH spin_uploads AS (
  SELECT CAST(id AS STRING) AS bulk_upload_id
  FROM `dostt-c1d96.dostt_pg_datastream_us.public_common_bulkupload`
  WHERE LOWER(name) LIKE '%spin%'
    AND created_at >= TIMESTAMP('2026-05-01 00:00:00', 'Asia/Kolkata')
),
active_spin_users AS (
  SELECT DISTINCT o.customer_id AS user_id
  FROM `dostt-c1d96.dostt_pg_datastream_us.public_payments_order` o
  WHERE o.type = 2
    AND o.status = 1
    AND o.initiated_date BETWEEN DATE '2026-07-25' AND DATE '2026-07-31'
    AND JSON_EXTRACT_SCALAR(o.metadata, '$.bulk_upload_id') IN (SELECT bulk_upload_id FROM spin_uploads)
),

/* ---------------- MONEY (July) ---------------- */
recharges AS (
  SELECT
    o.customer_id AS user_id,
    o.finalised_on,
    CAST(o.amount AS FLOAT64) AS amount,
    o.coins,
    o.offer_id,
    ROW_NUMBER() OVER (PARTITION BY o.customer_id ORDER BY o.finalised_on DESC) AS rn
  FROM `dostt-c1d96.dostt_pg_datastream_us.public_payments_order` o
  WHERE o.type = 1 AND o.status = 1 AND o.amount > 0
    AND o.finalised_on >= TIMESTAMP('2026-07-01 00:00:00', 'Asia/Kolkata')
    AND o.finalised_on <  TIMESTAMP('2026-08-01 00:00:00', 'Asia/Kolkata')
    AND o.customer_id IN (SELECT user_id FROM active_spin_users)
),
regular AS (
  SELECT
    user_id,
    COUNT(*)                                      AS recharges_month,
    APPROX_QUANTILES(amount, 2)[OFFSET(1)]        AS median_recharge,
    MIN(finalised_on)                             AS first_ts,
    MAX(finalised_on)                             AS last_ts,
    MAX(IF(rn = 1, coins, NULL))                  AS last_pack_coins,
    MAX(IF(rn = 2, coins, NULL))                  AS prev_pack_coins,
    AVG(IF(offer_id IS NOT NULL, 1.0, 0.0))       AS offer_share
  FROM recharges
  GROUP BY 1
  HAVING COUNT(*) >= 2
),
money_f AS (
  SELECT
    r.*,
    TIMESTAMP_DIFF(TIMESTAMP('2026-08-01 00:00:00', 'Asia/Kolkata'), r.last_ts, SECOND) / 86400.0
                                                                          AS days_since_last,
    GREATEST(TIMESTAMP_DIFF(r.last_ts, r.first_ts, SECOND) / 86400.0 / (r.recharges_month - 1), 0.5)
                                                                          AS usual_gap_days
  FROM regular r
),
next7 AS (
  SELECT o.customer_id AS user_id, SUM(CAST(o.amount AS FLOAT64)) AS rev_next7
  FROM `dostt-c1d96.dostt_pg_datastream_us.public_payments_order` o
  WHERE o.type = 1 AND o.status = 1 AND o.amount > 0
    AND o.finalised_on >= TIMESTAMP('2026-08-01 00:00:00', 'Asia/Kolkata')
    AND o.finalised_on <  TIMESTAMP('2026-08-08 00:00:00', 'Asia/Kolkata')
    AND o.customer_id IN (SELECT user_id FROM regular)
  GROUP BY 1
),

/* ---------------- CALLS (ETL: booking_talktime, connected calls only) ---------------- */
talk AS (
  SELECT
    t.user_id,
    t.expert_id,
    DATE(t.booked_at_ist)                       AS call_date,
    IFNULL(t.talktime_sec, 0)       / 60.0      AS minutes,
    IFNULL(t.talktime_sec_video, 0) / 60.0      AS video_minutes
  FROM `dostt-c1d96.aggregate_tables.booking_talktime` t
  WHERE t.booked_at_ist >= DATETIME '2026-07-18 00:00:00'
    AND t.booked_at_ist <  DATETIME '2026-08-01 00:00:00'
    AND t.user_id IN (SELECT user_id FROM regular)
),
call_agg AS (
  SELECT
    user_id,
    SUM(IF(call_date BETWEEN DATE '2026-07-25' AND DATE '2026-07-31', minutes, 0))       AS min_this_week,
    SUM(IF(call_date BETWEEN DATE '2026-07-18' AND DATE '2026-07-24', minutes, 0))       AS min_last_week,
    SUM(IF(call_date BETWEEN DATE '2026-07-25' AND DATE '2026-07-31', video_minutes, 0)) AS video_min
  FROM talk
  GROUP BY 1
),
repeat_listener AS (
  SELECT user_id, MAX(n) AS max_calls_same_listener
  FROM (
    SELECT user_id, expert_id, COUNT(*) AS n
    FROM talk
    WHERE call_date BETWEEN DATE '2026-07-25' AND DATE '2026-07-31'
    GROUP BY 1, 2
  )
  GROUP BY 1
),

/* ---------------- WALLET: calls that ended out of coins (25-31 Jul) ---------------- */
-- No ETL table has end-of-call balance, so this one still reads bookings_booking.
ran_out AS (
  SELECT b.customer_id AS user_id, COUNT(*) AS ran_out_calls
  FROM `dostt-c1d96.dostt_pg_datastream_us.public_bookings_booking` b
  WHERE b.booked_at >= TIMESTAMP('2026-07-25 00:00:00', 'Asia/Kolkata')
    AND b.booked_at <  TIMESTAMP('2026-08-01 00:00:00', 'Asia/Kolkata')
    AND b.started_at IS NOT NULL
    AND b.ended_at > b.started_at
    AND b.final_customer_balance < b.coins_per_minute
    AND b.customer_id IN (SELECT user_id FROM regular)
  GROUP BY 1
),

/* ---------------- SHOPPING ---------------- */
attempts AS (                     -- recharge attempts not completed, 25-31 Jul
  SELECT o.customer_id AS user_id, COUNT(*) AS unfinished_attempts_7d
  FROM `dostt-c1d96.dostt_pg_datastream_us.public_payments_order` o
  WHERE o.type = 1
    AND o.status IN (0, 2, 3, 4)
    AND o.initiated_date BETWEEN DATE '2026-07-25' AND DATE '2026-07-31'
    AND o.customer_id IN (SELECT user_id FROM regular)
  GROUP BY 1
),

/* ---------------- PROFILE (ETL: user_info) ---------------- */
profile AS (
  SELECT
    ui.user_id,
    ui.platform_onboarded,
    ui.country_onboarded,
    DATE_DIFF(DATE '2026-07-31', DATE(ui.first_login_at), DAY) AS account_age_days
  FROM `dostt-c1d96.aggregate_tables.user_info` ui
  WHERE ui.user_id IN (SELECT user_id FROM regular)
),

/* ---------------- POINTS (v2 weights) ---------------- */
pts AS (
  SELECT
    m.user_id,
    IFNULL(n.rev_next7, 0) AS rev_next7,

    -- MONEY (40)
    CASE WHEN m.median_recharge < 50 THEN 3 WHEN m.median_recharge < 150 THEN 5
         WHEN m.median_recharge < 500 THEN 9 ELSE 13 END                                   AS p_aov,          -- max 13
    CASE WHEN m.recharges_month >= 10 THEN 11 WHEN m.recharges_month >= 5 THEN 9
         WHEN m.recharges_month >= 3 THEN 7 ELSE 4 END                                     AS p_freq,         -- max 11
    CASE WHEN m.days_since_last / m.usual_gap_days < 0.5 THEN 3
         WHEN m.days_since_last / m.usual_gap_days <= 1.5 THEN 8
         WHEN m.days_since_last / m.usual_gap_days <= 3 THEN 4 ELSE 0 END                 AS p_due,          -- max 8
    CASE WHEN m.last_pack_coins > m.prev_pack_coins THEN 4
         WHEN m.last_pack_coins = m.prev_pack_coins THEN 3 ELSE 0 END                     AS p_pack_trend,   -- max 4
    CASE WHEN m.offer_share < 0.25 THEN 4 WHEN m.offer_share <= 0.75 THEN 3 ELSE 0 END    AS p_offer,        -- max 4

    -- CALLS (35)
    CASE WHEN IFNULL(c.min_this_week, 0) = 0 THEN 0 WHEN c.min_this_week < 15 THEN 4
         WHEN c.min_this_week < 60 THEN 8 WHEN c.min_this_week < 180 THEN 11 ELSE 14 END  AS p_minutes,      -- max 14
    CASE WHEN IFNULL(c.min_this_week, 0) = 0 AND IFNULL(c.min_last_week, 0) = 0 THEN 0
         WHEN IFNULL(c.min_last_week, 0) = 0 THEN 8
         WHEN c.min_this_week >= 1.2 * c.min_last_week THEN 8
         WHEN c.min_this_week >= 0.8 * c.min_last_week THEN 5 ELSE 1 END                  AS p_call_trend,   -- max 8
    CASE WHEN IFNULL(c.video_min, 0) = 0 THEN 0
         WHEN c.video_min < 0.25 * c.min_this_week THEN 3
         WHEN c.video_min < 0.50 * c.min_this_week THEN 6 ELSE 7 END                      AS p_video,        -- max 7
    CASE WHEN IFNULL(rl.max_calls_same_listener, 0) >= 3 THEN 6
         WHEN IFNULL(rl.max_calls_same_listener, 0) = 2 THEN 3 ELSE 0 END                 AS p_repeat,       -- max 6

    -- SHOPPING (15) - payment attempts
    CASE WHEN IFNULL(a.unfinished_attempts_7d, 0) >= 2 THEN 15
         WHEN IFNULL(a.unfinished_attempts_7d, 0) = 1 THEN 9 ELSE 0 END                   AS p_attempts,     -- max 15

    -- WALLET (5) - calls ended out of coins 2+ times in the last 7 days
    CASE WHEN IFNULL(r.ran_out_calls, 0) >= 2 THEN 5 ELSE 0 END                           AS p_ran_out,      -- max 5

    -- PROFILE (5)
    CASE WHEN LOWER(IFNULL(p.platform_onboarded, '')) LIKE 'ios%' THEN 2 ELSE 0 END       AS p_platform,     -- max 2
    CASE WHEN p.country_onboarded IS NULL OR LOWER(p.country_onboarded) = 'india' THEN 0
         ELSE 2 END                                                                        AS p_country,      -- max 2
    CASE WHEN p.account_age_days >= 90 THEN 1 ELSE 0 END                                  AS p_age           -- max 1
  FROM money_f m
  LEFT JOIN next7 n            ON n.user_id  = m.user_id
  LEFT JOIN call_agg c         ON c.user_id  = m.user_id
  LEFT JOIN repeat_listener rl ON rl.user_id = m.user_id
  LEFT JOIN ran_out r          ON r.user_id  = m.user_id
  LEFT JOIN attempts a         ON a.user_id  = m.user_id
  LEFT JOIN profile p          ON p.user_id  = m.user_id
)

/* ---------------- OUTPUT: USERS PER SCORE (distribution curve) ---------------- */
SELECT
  total_score,
  COUNT(*)                                                          AS users,
  ROUND(100 * COUNT(*) / SUM(COUNT(*)) OVER (), 2)                  AS pct_of_users,
  ROUND(100 * SUM(COUNT(*)) OVER (ORDER BY total_score)
            / SUM(COUNT(*)) OVER (), 1)                             AS cumulative_pct_users
FROM (
  SELECT
    p_aov + p_freq + p_due + p_pack_trend + p_offer
      + p_minutes + p_call_trend + p_video + p_repeat
      + p_attempts
      + p_ran_out
      + p_platform + p_country + p_age AS total_score
  FROM pts
)
GROUP BY 1
ORDER BY 1;
