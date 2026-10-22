/**
 * CloudCart - Product Service (port 5002)
 * ----------------------------------------
 * Responsibilities:
 *   - Product catalog (list / search / detail)         -> public
 *   - Create / update products                          -> admin only
 *   - Stock reservation & release (called by order-service via the internal token)
 *
 * Datastores: PostgreSQL (product_db), Redis (catalog cache, 60s TTL)
 */
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const Redis = require('ioredis');

const SERVICE = 'product-service';
const PORT = process.env.PORT || 5002;
const JWT_SECRET = process.env.JWT_SECRET || 'change-me-in-production';
const INTERNAL_TOKEN = process.env.INTERNAL_SERVICE_TOKEN || 'internal-dev-token';
const CACHE_TTL = parseInt(process.env.CACHE_TTL_SECONDS || '60');

const log = (level, msg, extra) =>
  console.log(JSON.stringify({ ts: new Date().toISOString(), service: SERVICE, level, msg, ...(extra || {}) }));

// ---------- PostgreSQL ----------
const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'password',
  database: process.env.DB_NAME || 'product_db',
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
  max: 10
});
pool.on('error', (err) => log('error', 'Idle PG client error', { error: err.message }));

// ---------- Redis ----------
const redis = new Redis({ host: process.env.REDIS_HOST || '127.0.0.1', port: parseInt(process.env.REDIS_PORT || '6379'), maxRetriesPerRequest: 1 });
redis.on('connect', () => log('info', 'Redis connected'));
redis.on('error', (err) => log('error', 'Redis error', { error: err.message }));
const cacheGet = async (k) => { try { return await redis.get(k); } catch { return null; } };
const cacheSet = async (k, v) => { try { await redis.set(k, v, 'EX', CACHE_TTL); } catch { /* cache is optional */ } };
const cacheBust = async () => { try { const keys = await redis.keys('products:*'); if (keys.length) await redis.del(keys); } catch { /* ignore */ } };

// ---------- middleware ----------
const app = express();
app.use(cors());
app.use(express.json());
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => log('access', `${req.method} ${req.originalUrl} -> ${res.statusCode}`, { ms: Date.now() - start }));
  next();
});
const protect = (req, res, next) => {
  const h = req.headers.authorization || '';
  if (!h.startsWith('Bearer ')) return res.status(401).json({ success: false, message: 'No token' });
  try { req.user = jwt.verify(h.slice(7), JWT_SECRET); next(); } catch { return res.status(401).json({ success: false, message: 'Invalid token' }); }
};
const adminOnly = (req, res, next) => (req.user?.role === 'admin' ? next() : res.status(403).json({ success: false, message: 'Admin only' }));
const internalOnly = (req, res, next) => (req.headers['x-internal-token'] === INTERNAL_TOKEN ? next() : res.status(403).json({ success: false, message: 'Internal endpoint' }));

// ---------- routes ----------
app.get(['/health', '/api/products/health'], async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'OK', service: SERVICE, database: 'connected', cache: redis.status, ts: new Date() });
  } catch (err) {
    res.status(503).json({ status: 'ERROR', service: SERVICE, database: 'disconnected', error: err.message });
  }
});

// GET /api/products?category=&q=
app.get('/api/products', async (req, res) => {
  const { category = 'All', q = '' } = req.query;
  const cacheKey = `products:${category}:${q}`;
  const cached = await cacheGet(cacheKey);
  if (cached) { res.set('X-Cache', 'HIT'); return res.json(JSON.parse(cached)); }
  try {
    const params = [];
    let sql = 'SELECT * FROM products WHERE is_active = TRUE';
    if (category && category !== 'All') { params.push(category); sql += ` AND category = $${params.length}`; }
    if (q) { params.push(`%${q}%`); sql += ` AND (name ILIKE $${params.length} OR description ILIKE $${params.length})`; }
    sql += ' ORDER BY id ASC';
    const { rows } = await pool.query(sql, params);
    const body = { success: true, products: rows };
    await cacheSet(cacheKey, JSON.stringify(body));
    res.set('X-Cache', 'MISS');
    res.json(body);
  } catch (err) {
    log('error', 'list products failed', { error: err.message });
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/products/categories
app.get('/api/products/categories', async (req, res) => {
  const { rows } = await pool.query('SELECT DISTINCT category FROM products ORDER BY category');
  res.json({ success: true, categories: rows.map(r => r.category) });
});

// GET /api/products/:id
app.get('/api/products/:id', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM products WHERE id = $1', [req.params.id]);
  if (!rows.length) return res.status(404).json({ success: false, message: 'Product not found' });
  res.json({ success: true, product: rows[0] });
});

// POST /api/products  (admin)
app.post('/api/products', protect, adminOnly, async (req, res) => {
  const { name, description = '', category, price, stock = 0, image_url = '' } = req.body || {};
  if (!name || !category || price === undefined) return res.status(400).json({ success: false, message: 'name, category, price are required' });
  try {
    const { rows } = await pool.query(
      'INSERT INTO products (name, description, category, price, stock, image_url) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
      [name, description, category, price, stock, image_url]);
    await cacheBust();
    res.status(201).json({ success: true, product: rows[0] });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// PUT /api/products/:id  (admin)
app.put('/api/products/:id', protect, adminOnly, async (req, res) => {
  const { name, description, category, price, stock, image_url, is_active } = req.body || {};
  try {
    const { rows } = await pool.query(
      `UPDATE products SET name = COALESCE($1,name), description = COALESCE($2,description), category = COALESCE($3,category),
       price = COALESCE($4,price), stock = COALESCE($5,stock), image_url = COALESCE($6,image_url), is_active = COALESCE($7,is_active),
       updated_at = NOW() WHERE id = $8 RETURNING *`,
      [name, description, category, price, stock, image_url, is_active, req.params.id]);
    if (!rows.length) return res.status(404).json({ success: false, message: 'Product not found' });
    await cacheBust();
    res.json({ success: true, product: rows[0] });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ---- internal endpoints (service-to-service, protected by X-Internal-Token) ----

// POST /api/products/internal/reserve  { items:[{product_id, quantity}] }
// Atomically decrements stock for every item or fails the whole request.
app.post('/api/products/internal/reserve', internalOnly, async (req, res) => {
  const items = (req.body && req.body.items) || [];
  if (!items.length) return res.status(400).json({ success: false, message: 'items required' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const reserved = [];
    for (const it of items) {
      const { rows } = await client.query('SELECT id, name, price, stock FROM products WHERE id = $1 AND is_active = TRUE FOR UPDATE', [it.product_id]);
      if (!rows.length) throw new Error(`Product ${it.product_id} not found`);
      if (rows[0].stock < it.quantity) throw new Error(`Insufficient stock for "${rows[0].name}" (available ${rows[0].stock})`);
      await client.query('UPDATE products SET stock = stock - $1, updated_at = NOW() WHERE id = $2', [it.quantity, it.product_id]);
      reserved.push({ product_id: rows[0].id, name: rows[0].name, unit_price: parseFloat(rows[0].price), quantity: it.quantity });
    }
    await client.query('COMMIT');
    await cacheBust();
    res.json({ success: true, items: reserved });
  } catch (err) {
    await client.query('ROLLBACK');
    log('warn', 'reserve failed', { error: err.message });
    res.status(409).json({ success: false, message: err.message });
  } finally { client.release(); }
});

// POST /api/products/internal/release  { items:[{product_id, quantity}] }
app.post('/api/products/internal/release', internalOnly, async (req, res) => {
  const items = (req.body && req.body.items) || [];
  for (const it of items) await pool.query('UPDATE products SET stock = stock + $1 WHERE id = $2', [it.quantity, it.product_id]);
  await cacheBust();
  res.json({ success: true });
});

app.listen(PORT, () => log('info', `Product service listening on ${PORT}`));
