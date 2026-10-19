-- Redash query for the reward engine's recharge sync (REDASH_RECHARGE_QUERY_ID).
-- Returns paid recharges from the last 3 days; the engine skips rows it has
-- already recorded (by recharge_id), so a missed night is caught up next run.
--
-- payments_order enums:
--   type:            1 = RECHARGE, 2 = FREE_COINS (spin-wheel transfers land here)
--   status:          0 PENDING, 1 PAID, 2 EXPIRED, 3 TERMINATED, 4 FAILED
--   payment_gateway: 0 NONE, 1 CASHFREE, 2 RAZORPAY, 3 JUSPAY
-- amount is in rupees (confirmed); discounted_amount is ignored.
--
-- payments_order.customer_id points at customers_customer; the wheel knows
-- players by their users_user id, so it is mapped through customers_customer.
-- TO CONFIRM: the column on customers_customer that holds the users_user id
-- (assumed user_id below).

SELECT
  c.user_id                                  AS user_id,
  o.id                                       AS recharge_id,
  o.amount                                   AS amount,
  o.coins                                    AS coins,
  COALESCE(o.finalised_on, o.updated_on)     AS recharged_at,
  FALSE                                      AS refunded
FROM payments_order o
JOIN customers_customer c ON c.id = o.customer_id
WHERE o.type = 1                 -- RECHARGE
  AND o.status = 1               -- PAID
  AND o.payment_gateway <> 0     -- real gateway payment
  AND o.amount > 0
  AND o.currency = 'INR'
  AND o.created_on >= NOW() - INTERVAL '3 days'
