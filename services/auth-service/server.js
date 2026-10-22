/**
 * CloudCart - Auth Service (port 5001)
 * -------------------------------------
 * Responsibilities:
 *   - Passwordless login: email -> 6-digit OTP (stored in Redis, 5 min TTL) -> JWT
 *   - User profile storage in MongoDB (no passwords are ever stored)
 *   - Admin: list users, change user status
 *
 * Datastores: MongoDB (users), Redis (OTP)
 * Optional:   AWS SES to email the OTP. If SES_SENDER_EMAIL is not set, the OTP is
 *             printed to the logs and (when DEV_SHOW_OTP=true) returned in the API
 *             response so you can demo without an email provider.
 */
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const Redis = require('ioredis');
const { SESClient, SendEmailCommand } = require('@aws-sdk/client-ses');

const SERVICE = 'auth-service';
const PORT = process.env.PORT || 5001;
const JWT_SECRET = process.env.JWT_SECRET || 'change-me-in-production';
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://admin:password@localhost:27017/cloudcart_auth?authSource=admin';
const REDIS_HOST = process.env.REDIS_HOST || '127.0.0.1';
const REDIS_PORT = parseInt(process.env.REDIS_PORT || '6379');
const DEV_SHOW_OTP = (process.env.DEV_SHOW_OTP || 'true') === 'true';

// ---------- logging (stdout only -> Docker / CloudWatch picks it up) ----------
const log = (level, msg, extra) =>
  console.log(JSON.stringify({ ts: new Date().toISOString(), service: SERVICE, level, msg, ...(extra || {}) }));

// ---------- MongoDB ----------
const UserSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  role: { type: String, enum: ['customer', 'admin'], default: 'customer' },
  status: { type: String, enum: ['pending', 'verified', 'blocked'], default: 'pending' },
  address: { type: String, default: '' },
  createdAt: { type: Date, default: Date.now }
});
const User = mongoose.model('User', UserSchema);

let mongoReady = false;
async function connectMongo() {
  try {
    await mongoose.connect(MONGODB_URI);
    mongoReady = true;
    log('info', 'MongoDB connected');
    await seedUsers();
  } catch (err) {
    log('error', 'MongoDB connection failed, retrying in 5s', { error: err.message });
    setTimeout(connectMongo, 5000);
  }
}

async function seedUsers() {
  if ((await User.countDocuments()) > 0) return;
  await User.create([
    { name: 'Store Admin', email: 'admin@cloudcart.local', role: 'admin', status: 'verified' },
    { name: 'Asha Customer', email: 'asha@cloudcart.local', role: 'customer', status: 'verified' },
    { name: 'Ravi Customer', email: 'ravi@cloudcart.local', role: 'customer', status: 'verified' }
  ]);
  log('info', 'Seeded default users (admin@cloudcart.local, asha@cloudcart.local, ravi@cloudcart.local)');
}

// ---------- Redis ----------
const redis = new Redis({ host: REDIS_HOST, port: REDIS_PORT, lazyConnect: false, maxRetriesPerRequest: 2 });
redis.on('connect', () => log('info', 'Redis connected', { host: REDIS_HOST }));
redis.on('error', (err) => log('error', 'Redis error', { error: err.message }));

// ---------- SES (optional) ----------
const sesClient = new SESClient({ region: process.env.AWS_REGION || 'us-east-1' });
async function deliverOtp(email, otp) {
  const sender = process.env.SES_SENDER_EMAIL;
  if (!sender) {
    log('info', `DEV MODE: OTP for ${email} is ${otp}`);
    return { emailed: false };
  }
  try {
    await sesClient.send(new SendEmailCommand({
      Source: sender,
      Destination: { ToAddresses: [email] },
      Message: {
        Subject: { Data: 'Your CloudCart login code' },
        Body: { Text: { Data: `Your CloudCart OTP is ${otp}. It expires in 5 minutes.` } }
      }
    }));
    log('info', 'OTP emailed via SES', { email });
    return { emailed: true };
  } catch (err) {
    log('error', 'SES send failed, falling back to log', { error: err.message });
    log('info', `DEV MODE FALLBACK: OTP for ${email} is ${otp}`);
    return { emailed: false };
  }
}

// ---------- middleware ----------
const app = express();
app.use(cors());
app.use(express.json());
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => log('access', `${req.method} ${req.originalUrl} -> ${res.statusCode}`, { ms: Date.now() - start }));
  next();
});

const protect = async (req, res, next) => {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) return res.status(401).json({ success: false, message: 'No token' });
  try {
    req.user = jwt.verify(header.slice(7), JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ success: false, message: 'Invalid or expired token' });
  }
};
const adminOnly = (req, res, next) =>
  req.user && req.user.role === 'admin' ? next() : res.status(403).json({ success: false, message: 'Admin only' });

const signToken = (u) =>
  jwt.sign({ id: u._id.toString(), name: u.name, email: u.email, role: u.role }, JWT_SECRET, { expiresIn: '7d' });

// ---------- routes ----------
app.get(['/health', '/api/auth/health'], async (req, res) => {
  const redisOk = redis.status === 'ready';
  const ok = mongoReady && redisOk;
  res.status(ok ? 200 : 503).json({ status: ok ? 'OK' : 'DEGRADED', service: SERVICE, mongo: mongoReady, redis: redisOk, ts: new Date() });
});

// POST /api/auth/request-otp  { email, name? }
app.post('/api/auth/request-otp', async (req, res) => {
  const { email, name } = req.body || {};
  if (!email) return res.status(400).json({ success: false, message: 'email is required' });
  try {
    let user = await User.findOne({ email: email.toLowerCase() });
    if (!user) {
      if (!name) return res.status(400).json({ success: false, message: 'name is required for a new account' });
      user = await User.create({ name, email, role: 'customer', status: 'pending' });
      log('info', 'New user registered', { email });
    }
    if (user.status === 'blocked') return res.status(403).json({ success: false, message: 'Account blocked. Contact support.' });

    const otp = String(Math.floor(100000 + Math.random() * 900000));
    await redis.set(`otp:${user.email}`, otp, 'EX', 300);
    const { emailed } = await deliverOtp(user.email, otp);

    const payload = { success: true, message: emailed ? 'OTP sent to your email' : 'OTP generated (dev mode - check logs)' };
    if (!emailed && DEV_SHOW_OTP) payload.dev_otp = otp; // demo convenience only; set DEV_SHOW_OTP=false in prod
    res.json(payload);
  } catch (err) {
    log('error', 'request-otp failed', { error: err.message });
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/auth/verify-otp  { email, otp }
app.post('/api/auth/verify-otp', async (req, res) => {
  const { email, otp } = req.body || {};
  if (!email || !otp) return res.status(400).json({ success: false, message: 'email and otp are required' });
  try {
    const key = `otp:${email.toLowerCase()}`;
    const stored = await redis.get(key);
    if (!stored) return res.status(401).json({ success: false, message: 'OTP expired or not requested' });
    if (stored !== String(otp)) return res.status(401).json({ success: false, message: 'Invalid OTP' });
    await redis.del(key);

    const user = await User.findOne({ email: email.toLowerCase() });
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    if (user.status === 'pending') { user.status = 'verified'; await user.save(); }

    res.json({ success: true, token: signToken(user), user: { id: user._id, name: user.name, email: user.email, role: user.role, status: user.status } });
  } catch (err) {
    log('error', 'verify-otp failed', { error: err.message });
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/auth/me
app.get('/api/auth/me', protect, async (req, res) => {
  const u = await User.findById(req.user.id);
  if (!u) return res.status(404).json({ success: false, message: 'User not found' });
  res.json({ success: true, user: { id: u._id, name: u.name, email: u.email, role: u.role, status: u.status, address: u.address, createdAt: u.createdAt } });
});

// PUT /api/auth/me  { name?, address? }
app.put('/api/auth/me', protect, async (req, res) => {
  const { name, address } = req.body || {};
  const u = await User.findByIdAndUpdate(req.user.id, { ...(name && { name }), ...(address !== undefined && { address }) }, { new: true });
  res.json({ success: true, user: { id: u._id, name: u.name, email: u.email, role: u.role, address: u.address } });
});

// GET /api/auth/users  (admin)
app.get('/api/auth/users', protect, adminOnly, async (req, res) => {
  const users = await User.find({}).sort({ createdAt: -1 });
  res.json({ success: true, users: users.map(u => ({ id: u._id, name: u.name, email: u.email, role: u.role, status: u.status, createdAt: u.createdAt })) });
});

// PUT /api/auth/users/:id/status  { status }  (admin)
app.put('/api/auth/users/:id/status', protect, adminOnly, async (req, res) => {
  const { status } = req.body || {};
  if (!['pending', 'verified', 'blocked'].includes(status)) return res.status(400).json({ success: false, message: 'Invalid status' });
  const u = await User.findByIdAndUpdate(req.params.id, { status }, { new: true });
  if (!u) return res.status(404).json({ success: false, message: 'User not found' });
  res.json({ success: true, user: { id: u._id, name: u.name, status: u.status } });
});

// ---------- start ----------
connectMongo();
app.listen(PORT, () => log('info', `Auth service listening on ${PORT}`));
