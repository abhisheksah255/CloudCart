/* CloudCart frontend
 * -------------------
 * All API calls go to the SAME ORIGIN the page was loaded from:
 *   locally  -> nginx (docker-compose) proxies /api/* to the right container
 *   on AWS   -> the Application Load Balancer routes /api/* to the right target group
 * That is why there is no "API base URL" config anywhere.
 */
const API = {
  auth: '/api/auth',
  products: '/api/products',
  cart: '/api/cart',
  orders: '/api/orders',
  payments: '/api/payments'
};

let token = localStorage.getItem('cc_token');
let user = JSON.parse(localStorage.getItem('cc_user') || 'null');
let otpEmail = '';
let category = 'All';
let pendingOrder = null;

// ---------- helpers ----------
async function api(url, method = 'GET', body) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && token) { logout(); throw new Error('Session expired, please login again'); }
  if (!res.ok) throw new Error(data.message || `Request failed (${res.status})`);
  return data;
}
const money = (n) => '₹' + Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2 });
const el = (id) => document.getElementById(id);
function toast(msg, type = 'ok') {
  const t = el('toast'); t.textContent = msg; t.className = `toast ${type}`;
  clearTimeout(t._h); t._h = setTimeout(() => t.classList.add('hidden'), 3000);
}
function showAlert(id, msg, type = 'danger') { const a = el(id); a.textContent = msg; a.className = `alert alert-${type}`; }

// ---------- navigation ----------
function navigate(page) {
  if (!token && page !== 'status') page = 'login';
  document.querySelectorAll('.page').forEach(p => p.classList.add('hidden'));
  el(`page-${page}`).classList.remove('hidden');
  document.querySelectorAll('.navlink').forEach(b => b.classList.toggle('active', b.dataset.page === page));
  if (page === 'shop') { loadCategories(); loadProducts(); }
  if (page === 'cart') loadCart();
  if (page === 'orders') loadOrders();
  if (page === 'admin') loadAdmin();
  if (page === 'status') loadHealth();
}
function renderAuthState() {
  const logged = !!token;
  el('nav').classList.toggle('hidden', !logged);
  el('user-chip').classList.toggle('hidden', !logged);
  el('logout-btn').classList.toggle('hidden', !logged);
  if (logged) {
    el('user-chip').textContent = `${user.name} (${user.role})`;
    document.querySelectorAll('.admin-only').forEach(e => e.classList.toggle('hidden', user.role !== 'admin'));
    refreshCartCount();
  }
}
function logout() {
  token = null; user = null;
  localStorage.removeItem('cc_token'); localStorage.removeItem('cc_user');
  renderAuthState(); navigate('login');
}

// ---------- auth ----------
async function requestOtp(e) {
  e.preventDefault();
  otpEmail = el('login-email').value.trim();
  try {
    const data = await api(`${API.auth}/request-otp`, 'POST', { email: otpEmail, name: el('login-name').value.trim() || undefined });
    el('form-email').classList.add('hidden'); el('form-otp').classList.remove('hidden');
    el('otp-email-label').textContent = otpEmail;
    el('login-alert').classList.add('hidden');
    if (data.dev_otp) { el('dev-otp').textContent = `DEV MODE — your OTP is ${data.dev_otp}`; el('dev-otp').classList.remove('hidden'); }
    else { el('dev-otp').classList.add('hidden'); }
  } catch (err) { showAlert('login-alert', err.message); }
}
async function verifyOtp(e) {
  e.preventDefault();
  try {
    const data = await api(`${API.auth}/verify-otp`, 'POST', { email: otpEmail, otp: el('login-otp').value.trim() });
    token = data.token; user = data.user;
    localStorage.setItem('cc_token', token); localStorage.setItem('cc_user', JSON.stringify(user));
    el('form-otp').reset(); el('form-email').reset();
    backToEmail(); renderAuthState(); navigate('shop');
    toast(`Welcome, ${user.name}!`);
  } catch (err) { showAlert('login-alert', err.message); }
}
function backToEmail() { el('form-otp').classList.add('hidden'); el('form-email').classList.remove('hidden'); }

// ---------- products ----------
async function loadCategories() {
  try {
    const { categories } = await api(`${API.products}/categories`);
    el('categories').innerHTML = ['All', ...categories].map(c =>
      `<button class="chip ${c === category ? 'active' : ''}" onclick="setCategory('${c}')">${c}</button>`).join('');
  } catch (err) { toast(err.message, 'err'); }
}
function setCategory(c) { category = c; loadCategories(); loadProducts(); }
async function loadProducts() {
  const q = el('search').value.trim();
  try {
    const { products } = await api(`${API.products}?category=${encodeURIComponent(category)}&q=${encodeURIComponent(q)}`);
    el('product-grid').innerHTML = products.length ? products.map(p => `
      <div class="card product">
        <div class="img" style="background-image:url('${p.image_url || ''}')"></div>
        <span class="badge">${p.category}</span>
        <h3>${p.name}</h3>
        <p class="muted small">${(p.description || '').slice(0, 90)}</p>
        <div class="row"><b>${money(p.price)}</b>
          ${p.stock > 0 ? `<span class="stock ok">${p.stock} in stock</span>` : `<span class="stock no">Out of stock</span>`}</div>
        <button class="btn btn-primary" ${p.stock === 0 ? 'disabled' : ''} onclick="addToCart(${p.id})">Add to cart</button>
      </div>`).join('') : '<p class="muted">No products found.</p>';
  } catch (err) { el('product-grid').innerHTML = `<p class="alert alert-danger">${err.message}</p>`; }
}

// ---------- cart ----------
async function refreshCartCount() {
  try { const { cart } = await api(API.cart); el('cart-count').textContent = cart.count; } catch { /* ignore */ }
}
async function addToCart(id) {
  try { const { cart } = await api(`${API.cart}/items`, 'POST', { product_id: id, quantity: 1 }); el('cart-count').textContent = cart.count; toast('Added to cart'); }
  catch (err) { toast(err.message, 'err'); }
}
async function loadCart() {
  try {
    const { cart } = await api(API.cart);
    el('cart-count').textContent = cart.count;
    if (!cart.items.length) { el('cart-items').innerHTML = '<p class="muted">Your cart is empty.</p>'; el('cart-summary').classList.add('hidden'); return; }
    el('cart-items').innerHTML = cart.items.map(i => `
      <div class="card cart-row">
        <div class="img sm" style="background-image:url('${i.image_url || ''}')"></div>
        <div class="grow"><b>${i.name}</b><div class="muted small">${money(i.price)} each · ${i.stock} available</div></div>
        <div class="qty">
          <button onclick="setQty(${i.product_id}, ${i.quantity - 1})">−</button><span>${i.quantity}</span><button onclick="setQty(${i.product_id}, ${i.quantity + 1})">+</button>
        </div>
        <b>${money(i.subtotal)}</b>
        <button class="btn btn-ghost" onclick="setQty(${i.product_id}, 0)">✕</button>
      </div>`).join('');
    el('cart-total').textContent = money(cart.total);
    el('ship-address').value = el('ship-address').value || (user.address || '');
    el('cart-summary').classList.remove('hidden');
  } catch (err) { el('cart-items').innerHTML = `<p class="alert alert-danger">${err.message}</p>`; }
}
async function setQty(productId, qty) {
  try { await api(`${API.cart}/items/${productId}`, 'PUT', { quantity: qty }); loadCart(); } catch (err) { toast(err.message, 'err'); }
}

// ---------- checkout & payment ----------
async function checkout() {
  try {
    const { order } = await api(API.orders, 'POST', { shipping_address: el('ship-address').value.trim() });
    pendingOrder = order;
    el('pay-order-id').textContent = `#${order.id}`; el('pay-amount').textContent = money(order.total_amount);
    el('pay-alert').classList.add('hidden');
    refreshCartCount(); navigate('payment');
  } catch (err) { toast(err.message, 'err'); }
}
async function confirmPayment() {
  try {
    const { payment } = await api(API.payments, 'POST', { order_id: pendingOrder.id, method: el('pay-method').value });
    const result = await api(`${API.payments}/${payment.id}/confirm`, 'POST', { card_last4: el('pay-last4').value.trim() });
    if (result.success) { toast('Payment successful 🎉'); navigate('orders'); }
    else { showAlert('pay-alert', result.message); setTimeout(() => navigate('orders'), 1500); }
  } catch (err) { showAlert('pay-alert', err.message); }
}

// ---------- orders ----------
const statusBadge = (s) => `<span class="badge st-${s.toLowerCase()}">${s.replace('_', ' ')}</span>`;
async function loadOrders() {
  try {
    const { orders } = await api(API.orders);
    const mine = orders.filter(o => o.user_id === user.id);
    el('orders-list').innerHTML = mine.length ? mine.map(o => `
      <div class="card order-row" onclick="toggleOrder(${o.id})">
        <div class="row"><b>Order #${o.id}</b>${statusBadge(o.status)}</div>
        <div class="muted small">${new Date(o.created_at).toLocaleString()} · ${money(o.total_amount)}</div>
        <div id="order-items-${o.id}" class="order-items hidden"></div>
      </div>`).join('') : '<p class="muted">No orders yet.</p>';
  } catch (err) { el('orders-list').innerHTML = `<p class="alert alert-danger">${err.message}</p>`; }
}
async function toggleOrder(id) {
  const box = el(`order-items-${id}`);
  if (!box.classList.contains('hidden')) return box.classList.add('hidden');
  const { order } = await api(`${API.orders}/${id}`);
  box.innerHTML = order.items.map(i => `<div class="row small"><span>${i.product_name} × ${i.quantity}</span><span>${money(i.unit_price * i.quantity)}</span></div>`).join('')
    + `<div class="muted small">Ship to: ${order.shipping_address || '—'}</div>`;
  box.classList.remove('hidden');
}

// ---------- admin ----------
async function addProduct(e) {
  e.preventDefault();
  try {
    await api(API.products, 'POST', { name: el('p-name').value, category: el('p-category').value, price: parseFloat(el('p-price').value), stock: parseInt(el('p-stock').value), image_url: el('p-image').value, description: el('p-desc').value });
    toast('Product created'); e.target.reset();
  } catch (err) { toast(err.message, 'err'); }
}
async function loadAdmin() {
  try {
    const { users } = await api(`${API.auth}/users`);
    el('users-list').innerHTML = users.map(u => `
      <div class="row small"><span>${u.name} <span class="muted">${u.email}</span></span>
        <select onchange="setUserStatus('${u.id}', this.value)">
          ${['pending', 'verified', 'blocked'].map(s => `<option ${s === u.status ? 'selected' : ''}>${s}</option>`).join('')}
        </select></div>`).join('');
    const { orders } = await api(API.orders);
    el('admin-orders').innerHTML = orders.slice(0, 20).map(o => `
      <div class="row small"><span>#${o.id} ${o.user_email} · ${money(o.total_amount)}</span>
        <select onchange="setOrderStatus(${o.id}, this.value)">
          ${['PENDING_PAYMENT', 'PAID', 'SHIPPED', 'DELIVERED', 'CANCELLED', 'PAYMENT_FAILED'].map(s => `<option ${s === o.status ? 'selected' : ''}>${s}</option>`).join('')}
        </select></div>`).join('') || '<p class="muted">No orders.</p>';
  } catch (err) { toast(err.message, 'err'); }
}
async function setUserStatus(id, status) { try { await api(`${API.auth}/users/${id}/status`, 'PUT', { status }); toast('User updated'); } catch (err) { toast(err.message, 'err'); } }
async function setOrderStatus(id, status) { try { await api(`${API.orders}/${id}/status`, 'PUT', { status }); toast('Order updated'); } catch (err) { toast(err.message, 'err'); } }

// ---------- health page ----------
async function loadHealth() {
  // The ALB / nginx only route /api/* paths, so every service also exposes its health check under its own prefix.
  const checks = [
    ['frontend', '/health'], ['auth-service', '/api/auth/health'], ['product-service', '/api/products/health'],
    ['cart-service', '/api/cart/health'], ['order-service', '/api/orders/health'], ['payment-service', '/api/payments/health']
  ];
  el('health-grid').innerHTML = checks.map(([n]) => `<div class="card" id="h-${n}"><h3>${n}</h3><p class="muted">checking…</p></div>`).join('');
  for (const [name, path] of checks) {
    const box = el(`h-${name}`);
    try {
      const r = await fetch(path); const d = await r.json();
      box.innerHTML = `<h3>${name}</h3><p>${r.ok ? '🟢' : '🔴'} ${d.status}</p><pre class="small">${JSON.stringify(d, null, 1)}</pre>`;
    } catch (err) { box.innerHTML = `<h3>${name}</h3><p>🔴 unreachable</p><p class="small muted">${err.message}</p>`; }
  }
}

// ---------- boot ----------
renderAuthState();
navigate(token ? 'shop' : 'login');
