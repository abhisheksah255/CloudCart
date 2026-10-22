-- ===== product_db : owned by product-service =====
\connect product_db

CREATE TABLE IF NOT EXISTS products (
    id          SERIAL PRIMARY KEY,
    name        VARCHAR(200)  NOT NULL,
    description TEXT          DEFAULT '',
    category    VARCHAR(60)   NOT NULL,          -- Electronics, Books, Fashion, Home, Sports
    price       NUMERIC(10,2) NOT NULL CHECK (price >= 0),
    stock       INT           NOT NULL DEFAULT 0 CHECK (stock >= 0),
    image_url   TEXT          DEFAULT '',
    is_active   BOOLEAN       NOT NULL DEFAULT TRUE,
    created_at  TIMESTAMPTZ   DEFAULT NOW(),
    updated_at  TIMESTAMPTZ   DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_products_category ON products(category);

INSERT INTO products (name, description, category, price, stock, image_url) VALUES
('Wireless Headphones',  'Over-ear Bluetooth headphones with 30h battery and active noise cancelling.', 'Electronics', 2999.00, 25, 'https://images.unsplash.com/photo-1505740420928-5e560c06d30e?w=400'),
('Mechanical Keyboard',  'Compact 75% keyboard with hot-swappable switches and RGB backlight.',        'Electronics', 4499.00, 12, 'https://images.unsplash.com/photo-1587829741301-dc798b83add3?w=400'),
('Smart Watch',          'Fitness tracking, heart-rate monitor, 7-day battery, water resistant.',       'Electronics', 5999.00,  8, 'https://images.unsplash.com/photo-1523275335684-37898b6baf30?w=400'),
('Clean Code',           'Robert C. Martin - a handbook of agile software craftsmanship.',             'Books',        599.00, 40, 'https://images.unsplash.com/photo-1532012197267-da84d127e765?w=400'),
('Designing Data-Intensive Applications', 'Martin Kleppmann - the big ideas behind reliable, scalable systems.', 'Books', 899.00, 15, 'https://images.unsplash.com/photo-1544716278-ca5e3f4abd8c?w=400'),
('AWS Certified Solutions Architect Guide', 'Study guide for the SAA-C03 exam with practice tests.', 'Books', 1299.00, 20, 'https://images.unsplash.com/photo-1456513080510-7bf3a84b82f8?w=400'),
('Cotton T-Shirt',       'Plain crew-neck tee, 100% combed cotton, unisex.',                            'Fashion',      499.00, 60, 'https://images.unsplash.com/photo-1521572163474-6864f9cf17ab?w=400'),
('Running Shoes',        'Lightweight cushioned trainers for road running.',                             'Fashion',     3499.00, 10, 'https://images.unsplash.com/photo-1542291026-7eec264c27ff?w=400'),
('Ceramic Coffee Mug',   '350 ml stoneware mug, dishwasher safe.',                                      'Home',         299.00,  0, 'https://images.unsplash.com/photo-1514228742587-6b1558fcca3d?w=400'),
('Desk Lamp',            'LED desk lamp with 3 colour temperatures and USB charging port.',             'Home',        1499.00, 18, 'https://images.unsplash.com/photo-1507473885765-e6ed057f782c?w=400'),
('Yoga Mat',             '6 mm non-slip TPE mat with carry strap.',                                      'Sports',       899.00, 22, 'https://images.unsplash.com/photo-1601925260368-ae2f83cf8b7f?w=400'),
('Football',             'Size 5 match ball, machine stitched.',                                         'Sports',      1199.00,  5, 'https://images.unsplash.com/photo-1614632537423-1e6c2e7e0aab?w=400');
-- Note: "Ceramic Coffee Mug" is seeded with stock 0 so you can test the out-of-stock path.
