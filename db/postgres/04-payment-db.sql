-- ===== payment_db : owned by payment-service =====
\connect payment_db

CREATE TABLE IF NOT EXISTS payments (
    id          SERIAL PRIMARY KEY,
    order_id    INT           NOT NULL,          -- id in order_db.orders (no FK: different database)
    user_id     VARCHAR(50)   NOT NULL,
    amount      NUMERIC(12,2) NOT NULL,
    method      VARCHAR(20)   NOT NULL DEFAULT 'card',   -- card | upi | cod
    status      VARCHAR(20)   NOT NULL DEFAULT 'INITIATED', -- INITIATED | SUCCESS | FAILED
    gateway_ref VARCHAR(60),
    created_at  TIMESTAMPTZ   DEFAULT NOW(),
    updated_at  TIMESTAMPTZ   DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_payments_order ON payments(order_id);
