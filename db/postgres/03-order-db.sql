-- ===== order_db : owned by order-service =====
\connect order_db

CREATE TABLE IF NOT EXISTS orders (
    id               SERIAL PRIMARY KEY,
    user_id          VARCHAR(50)   NOT NULL,   -- MongoDB ObjectId string from auth-service
    user_email       VARCHAR(200)  NOT NULL,
    status           VARCHAR(30)   NOT NULL DEFAULT 'PENDING_PAYMENT',
                     -- PENDING_PAYMENT -> PAID -> SHIPPED -> DELIVERED
                     --                 -> PAYMENT_FAILED / CANCELLED
    total_amount     NUMERIC(12,2) NOT NULL,
    shipping_address TEXT          DEFAULT '',
    payment_id       INT,                      -- id in payment_db.payments (no FK: different database)
    created_at       TIMESTAMPTZ   DEFAULT NOW(),
    updated_at       TIMESTAMPTZ   DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id);

CREATE TABLE IF NOT EXISTS order_items (
    id            SERIAL PRIMARY KEY,
    order_id      INT           NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    product_id    INT           NOT NULL,       -- id in product_db.products (no FK: different database)
    product_name  VARCHAR(200)  NOT NULL,       -- snapshot at purchase time
    unit_price    NUMERIC(10,2) NOT NULL,       -- snapshot at purchase time
    quantity      INT           NOT NULL CHECK (quantity > 0)
);
