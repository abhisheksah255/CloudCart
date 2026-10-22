/**
 * CloudCart - Order Service (port 5004)
 * --------------------------------------
 * The "orchestrator" of checkout. For POST /api/orders it:
 *   1. reads the user's cart            -> cart-service     (internal)
 *   2. reserves stock atomically        -> product-service  (internal)
 *   3. writes the order + line items    -> PostgreSQL (order_db)
 *   4. clears the cart                  -> cart-service     (internal)
 *   5. (payment-service later calls back /internal/:id/paid)
 * If step 3 fails, it releases the stock again (compensating action).
 *
 * Datastore: PostgreSQL (order_db)
 */
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');

const SERVICE = 'order-service';
const PORT = process.env.PORT || 5004;
const JWT_SECRET = process.env.JWT_SECRET || 'change-me-in-production';
const INTERNAL_TOKEN = process.env.INTERNAL_SERVICE_TOKEN || 'internal-dev-token';
const CART_SERVICE_URL = process.env.CART_SERVICE_URL || 'http://localhost:5003';
const PRODUCT_SERVICE_URL = process.env.PRODUCT_SERVICE_URL || 'http://localhost:5002';

const log = (level, msg, extra) =>
  console.log(JSON.stringify({ ts: new Date().toISOString(), service: SERVICE, level, msg, ...(extra || {}) }));

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'password',
  database: process.env.DB_NAME || 'order_db',
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
  max: 10
});
pool.on('error', (err) => log('error', 'Idle PG client error', { error: err.message }));

const internalHeaders = { 'Content-Type': 'application/json', 'X-Internal-Token': INTERNAL_TOKEN };
async function callInternal(method, url, body) {
  const r = await fetch(url, { method, headers: internalHeaders, body: body ? JSON.stringify(body) : undefined });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.message || `${method} ${url} -> ${r.status}`);
  return data;
}

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

async function loadOrder(id) {
  const { rows } = await pool.query('SELECT * FROM orders WHERE id = $1', [id]);
  if (!rows.length) return null;
  const items = await pool.query('SELECT * FROM order_items WHERE order_id = $1 ORDER BY id', [id]);
  return { ...rows[0], items: items.rows };
}

// ---------- routes ----------
app.get(['/health', '/api/orders/health'], async (req, res) => {
  try { await pool.query('SELECT 1'); res.json({ status: 'OK', service: SERVICE, database: 'connected', ts: new Date() }); }
  catch (err) { res.status(503).json({ status: 'ERROR', service: SERVICE, database: 'disconnected', error: err.message }); }
});

// POST /api/orders  { shipping_address }
app.post('/api/orders', protect, async (req, res) => {
  const { shipping_address = '' } = req.body || {};
  const userId = req.user.id;
  let reserved = null;
  try {
    // 1. cart
    const { cart } = await callInternal('GET', `${CART_SERVICE_URL}/api/cart/internal/${userId}`);
    if (!cart.items.length) return res.status(400).json({ success: false, message: 'Cart is empty' });

    // 2. reserve stock
    const reserveRes = await callInternal('POST', `${PRODUCT_SERVICE_URL}/api/products/internal/reserve`,
      { items: cart.items.map(i => ({ product_id: i.product_id, quantity: i.quantity })) });
    reserved = reserveRes.items;

    // 3. persist order
    const client = await pool.connect();
    let order;
    try {
      await client.query('BEGIN');
      const total = reserved.reduce((s, i) => s + i.unit_price * i.quantity, 0);
      const o = await client.query(
        'INSERT INTO orders (user_id, user_email, status, total_amount, shipping_address) VALUES ($1,$2,$3,$4,$5) RETURNING *',
        [userId, req.user.email, 'PENDING_PAYMENT', total.toFixed(2), shipping_address]);
      order = o.rows[0];
      for (const i of reserved) {
        await client.query('INSERT INTO order_items (order_id, product_id, product_name, unit_price, quantity) VALUES ($1,$2,$3,$4,$5)',
          [order.id, i.product_id, i.name, i.unit_price, i.quantity]);
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally { client.release(); }

    // 4. clear cart
    await callInternal('DELETE', `${CART_SERVICE_URL}/api/cart/internal/${userId}`).catch(e => log('warn', 'cart clear failed', { error: e.message }));

    log('info', 'Order created', { orderId: order.id, userId, total: order.total_amount });
    res.status(201).json({ success: true, order: await loadOrder(order.id) });
  } catch (err) {
    // compensate: give stock back if we reserved it but failed afterwards
    if (reserved) await callInternal('POST', `${PRODUCT_SERVICE_URL}/api/products/internal/release`, { items: reserved }).catch(() => {});
    log('error', 'checkout failed', { error: err.message });
    res.status(409).json({ success: false, message: err.message });
  }
});

// GET /api/orders  (own orders; admin sees all)
app.get('/api/orders', protect, async (req, res) => {
  const sql = req.user.role === 'admin'
    ? 'SELECT * FROM orders ORDER BY created_at DESC LIMIT 200'
    : 'SELECT * FROM orders WHERE user_id = $1 ORDER BY created_at DESC';
  const { rows } = await pool.query(sql, req.user.role === 'admin' ? [] : [req.user.id]);
  res.json({ success: true, orders: rows });
});

// GET /api/orders/:id
app.get('/api/orders/:id', protect, async (req, res) => {
  const order = await loadOrder(req.params.id);
  if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
  if (order.user_id !== req.user.id && req.user.role !== 'admin') return res.status(403).json({ success: false, message: 'Forbidden' });
  res.json({ success: true, order });
});

// PUT /api/orders/:id/status  { status }  (admin: SHIPPED / DELIVERED / CANCELLED)
app.put('/api/orders/:id/status', protect, adminOnly, async (req, res) => {
  const { status } = req.body || {};
  if (!['PAID', 'SHIPPED', 'DELIVERED', 'CANCELLED'].includes(status)) return res.status(400).json({ success: false, message: 'Invalid status' });
  const { rows } = await pool.query('UPDATE orders SET status = $1, updated_at = NOW() WHERE id = $2 RETURNING *', [status, req.params.id]);
  if (!rows.length) return res.status(404).json({ success: false, message: 'Order not found' });
  res.json({ success: true, order: rows[0] });
});

// ---- internal: payment-service tells us the result ----
app.post('/api/orders/internal/:id/payment-result', internalOnly, async (req, res) => {
  const { success, payment_id } = req.body || {};
  const order = await loadOrder(req.params.id);
  if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
  if (success) {
    await pool.query('UPDATE orders SET status = $1, payment_id = $2, updated_at = NOW() WHERE id = $3', ['PAID', payment_id, order.id]);
  } else {
    await pool.query('UPDATE orders SET status = $1, updated_at = NOW() WHERE id = $2', ['PAYMENT_FAILED', order.id]);
    await callInternal('POST', `${PRODUCT_SERVICE_URL}/api/products/internal/release`,
      { items: order.items.map(i => ({ product_id: i.product_id, quantity: i.quantity })) }).catch(() => {});
  }
  res.json({ success: true });
});
app.get('/api/orders/internal/:id', internalOnly, async (req, res) => {
  const order = await loadOrder(req.params.id);
  if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
  res.json({ success: true, order });
});

app.listen(PORT, () => log('info', `Order service listening on ${PORT}`, { cartService: CART_SERVICE_URL, productService: PRODUCT_SERVICE_URL }));
