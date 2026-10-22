/**
 * CloudCart - Cart Service (port 5003)
 * -------------------------------------
 * Responsibilities:
 *   - One cart per logged-in user, stored as a Redis hash  cart:<userId>  { productId: quantity }
 *   - Validates products by calling product-service (service-to-service HTTP)
 *   - Internal endpoints used by order-service during checkout (read + clear)
 *
 * Datastore: Redis (carts expire after 7 days of inactivity)
 */
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const Redis = require('ioredis');

const SERVICE = 'cart-service';
const PORT = process.env.PORT || 5003;
const JWT_SECRET = process.env.JWT_SECRET || 'change-me-in-production';
const INTERNAL_TOKEN = process.env.INTERNAL_SERVICE_TOKEN || 'internal-dev-token';
const PRODUCT_SERVICE_URL = process.env.PRODUCT_SERVICE_URL || 'http://localhost:5002';
const CART_TTL = 7 * 24 * 3600;

const log = (level, msg, extra) =>
  console.log(JSON.stringify({ ts: new Date().toISOString(), service: SERVICE, level, msg, ...(extra || {}) }));

const redis = new Redis({ host: process.env.REDIS_HOST || '127.0.0.1', port: parseInt(process.env.REDIS_PORT || '6379'), maxRetriesPerRequest: 2 });
redis.on('connect', () => log('info', 'Redis connected'));
redis.on('error', (err) => log('error', 'Redis error', { error: err.message }));

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
const internalOnly = (req, res, next) => (req.headers['x-internal-token'] === INTERNAL_TOKEN ? next() : res.status(403).json({ success: false, message: 'Internal endpoint' }));

// Fetch product details from product-service for every id in the cart
async function hydrate(cartHash) {
  const items = [];
  for (const [productId, qty] of Object.entries(cartHash)) {
    try {
      const r = await fetch(`${PRODUCT_SERVICE_URL}/api/products/${productId}`);
      if (!r.ok) continue;
      const { product } = await r.json();
      items.push({ product_id: product.id, name: product.name, price: parseFloat(product.price), image_url: product.image_url, stock: product.stock, quantity: parseInt(qty), subtotal: parseFloat(product.price) * parseInt(qty) });
    } catch (err) {
      log('error', 'product-service unreachable', { error: err.message, url: PRODUCT_SERVICE_URL });
      items.push({ product_id: parseInt(productId), name: 'Unavailable', price: 0, quantity: parseInt(qty), subtotal: 0, stock: 0 });
    }
  }
  const total = items.reduce((s, i) => s + i.subtotal, 0);
  return { items, total: parseFloat(total.toFixed(2)), count: items.reduce((s, i) => s + i.quantity, 0) };
}
const key = (userId) => `cart:${userId}`;

// ---------- routes ----------
app.get(['/health', '/api/cart/health'], (req, res) => {
  const ok = redis.status === 'ready';
  res.status(ok ? 200 : 503).json({ status: ok ? 'OK' : 'ERROR', service: SERVICE, redis: redis.status, ts: new Date() });
});

// GET /api/cart
app.get('/api/cart', protect, async (req, res) => {
  const cart = await redis.hgetall(key(req.user.id));
  res.json({ success: true, cart: await hydrate(cart) });
});

// POST /api/cart/items  { product_id, quantity }
app.post('/api/cart/items', protect, async (req, res) => {
  const { product_id, quantity = 1 } = req.body || {};
  if (!product_id) return res.status(400).json({ success: false, message: 'product_id required' });
  try {
    const r = await fetch(`${PRODUCT_SERVICE_URL}/api/products/${product_id}`);
    if (!r.ok) return res.status(404).json({ success: false, message: 'Product not found' });
    const { product } = await r.json();
    const current = parseInt((await redis.hget(key(req.user.id), String(product_id))) || '0');
    const wanted = current + parseInt(quantity);
    if (wanted > product.stock) return res.status(409).json({ success: false, message: `Only ${product.stock} left in stock` });
    await redis.hset(key(req.user.id), String(product_id), wanted);
    await redis.expire(key(req.user.id), CART_TTL);
    res.json({ success: true, cart: await hydrate(await redis.hgetall(key(req.user.id))) });
  } catch (err) {
    log('error', 'add to cart failed', { error: err.message });
    res.status(502).json({ success: false, message: 'Product service unavailable' });
  }
});

// PUT /api/cart/items/:productId  { quantity }   (quantity 0 removes)
app.put('/api/cart/items/:productId', protect, async (req, res) => {
  const qty = parseInt((req.body || {}).quantity);
  if (isNaN(qty) || qty < 0) return res.status(400).json({ success: false, message: 'quantity must be >= 0' });
  if (qty === 0) await redis.hdel(key(req.user.id), req.params.productId);
  else await redis.hset(key(req.user.id), req.params.productId, qty);
  res.json({ success: true, cart: await hydrate(await redis.hgetall(key(req.user.id))) });
});

// DELETE /api/cart/items/:productId
app.delete('/api/cart/items/:productId', protect, async (req, res) => {
  await redis.hdel(key(req.user.id), req.params.productId);
  res.json({ success: true, cart: await hydrate(await redis.hgetall(key(req.user.id))) });
});

// DELETE /api/cart
app.delete('/api/cart', protect, async (req, res) => {
  await redis.del(key(req.user.id));
  res.json({ success: true, cart: { items: [], total: 0, count: 0 } });
});

// ---- internal (order-service) ----
app.get('/api/cart/internal/:userId', internalOnly, async (req, res) => {
  res.json({ success: true, cart: await hydrate(await redis.hgetall(key(req.params.userId))) });
});
app.delete('/api/cart/internal/:userId', internalOnly, async (req, res) => {
  await redis.del(key(req.params.userId));
  res.json({ success: true });
});

app.listen(PORT, () => log('info', `Cart service listening on ${PORT}`, { productService: PRODUCT_SERVICE_URL }));
