/**
 * CloudCart - Payment Service (port 5005)
 * ----------------------------------------
 * A mock payment gateway. Real gateways (Razorpay, Stripe) work the same way:
 *   create a payment intent -> customer "pays" -> gateway confirms -> we notify order-service.
 *
 *   POST /api/payments            { order_id, method }      -> creates a payment (INITIATED)
 *   POST /api/payments/:id/confirm { card_last4 }           -> simulates the gateway result
 *        card ending "0000" => declined, anything else => success
 *   Then it calls order-service  /api/orders/internal/:orderId/payment-result
 *
 * Datastore: PostgreSQL (payment_db)
 */
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');

const SERVICE = 'payment-service';
const PORT = process.env.PORT || 5005;
const JWT_SECRET = process.env.JWT_SECRET || 'change-me-in-production';
const INTERNAL_TOKEN = process.env.INTERNAL_SERVICE_TOKEN || 'internal-dev-token';
const ORDER_SERVICE_URL = process.env.ORDER_SERVICE_URL || 'http://localhost:5004';

const log = (level, msg, extra) =>
  console.log(JSON.stringify({ ts: new Date().toISOString(), service: SERVICE, level, msg, ...(extra || {}) }));

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'password',
  database: process.env.DB_NAME || 'payment_db',
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

// ---------- routes ----------
app.get(['/health', '/api/payments/health'], async (req, res) => {
  try { await pool.query('SELECT 1'); res.json({ status: 'OK', service: SERVICE, database: 'connected', ts: new Date() }); }
  catch (err) { res.status(503).json({ status: 'ERROR', service: SERVICE, database: 'disconnected', error: err.message }); }
});

// POST /api/payments  { order_id, method: 'card' | 'upi' | 'cod' }
app.post('/api/payments', protect, async (req, res) => {
  const { order_id, method = 'card' } = req.body || {};
  if (!order_id) return res.status(400).json({ success: false, message: 'order_id required' });
  try {
    const { order } = await callInternal('GET', `${ORDER_SERVICE_URL}/api/orders/internal/${order_id}`);
    if (order.user_id !== req.user.id) return res.status(403).json({ success: false, message: 'Not your order' });
    if (order.status !== 'PENDING_PAYMENT') return res.status(409).json({ success: false, message: `Order is ${order.status}` });

    const { rows } = await pool.query(
      'INSERT INTO payments (order_id, user_id, amount, method, status) VALUES ($1,$2,$3,$4,$5) RETURNING *',
      [order.id, req.user.id, order.total_amount, method, 'INITIATED']);
    res.status(201).json({ success: true, payment: rows[0] });
  } catch (err) {
    log('error', 'create payment failed', { error: err.message });
    res.status(502).json({ success: false, message: err.message });
  }
});

// POST /api/payments/:id/confirm  { card_last4 }
app.post('/api/payments/:id/confirm', protect, async (req, res) => {
  const { card_last4 = '4242' } = req.body || {};
  const { rows } = await pool.query('SELECT * FROM payments WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
  if (!rows.length) return res.status(404).json({ success: false, message: 'Payment not found' });
  const payment = rows[0];
  if (payment.status !== 'INITIATED') return res.status(409).json({ success: false, message: `Payment already ${payment.status}` });

  // --- simulate the gateway ---
  const approved = String(card_last4) !== '0000';
  const gatewayRef = `MOCK-${Date.now().toString(36).toUpperCase()}`;
  const status = approved ? 'SUCCESS' : 'FAILED';
  const updated = await pool.query(
    'UPDATE payments SET status = $1, gateway_ref = $2, updated_at = NOW() WHERE id = $3 RETURNING *', [status, gatewayRef, payment.id]);

  // tell order-service
  try {
    await callInternal('POST', `${ORDER_SERVICE_URL}/api/orders/internal/${payment.order_id}/payment-result`, { success: approved, payment_id: payment.id });
  } catch (err) {
    log('error', 'order-service callback failed', { error: err.message });
  }
  log('info', `Payment ${status}`, { paymentId: payment.id, orderId: payment.order_id, amount: payment.amount });
  res.json({ success: approved, payment: updated.rows[0], message: approved ? 'Payment successful' : 'Payment declined by gateway (test card 0000)' });
});

// GET /api/payments/order/:orderId
app.get('/api/payments/order/:orderId', protect, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM payments WHERE order_id = $1 AND user_id = $2 ORDER BY created_at DESC', [req.params.orderId, req.user.id]);
  res.json({ success: true, payments: rows });
});

app.listen(PORT, () => log('info', `Payment service listening on ${PORT}`, { orderService: ORDER_SERVICE_URL }));
