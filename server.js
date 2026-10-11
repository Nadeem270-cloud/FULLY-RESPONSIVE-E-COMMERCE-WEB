require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const morgan = require('morgan');
const crypto = require('crypto');
const path = require('path');
const Razorpay = require('razorpay');
const db = require('./db');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const appEnv = process.env.NODE_ENV || 'development';
const configuredSessionSecret = process.env.SESSION_SECRET || '';
const SESSION_SECRET = configuredSessionSecret || crypto.randomBytes(32).toString('hex');
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
const ADMIN_SETUP_TOKEN = process.env.ADMIN_SETUP_TOKEN || '';
const hasRazorpay = Boolean(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET);
const razorpay = hasRazorpay ? new Razorpay({ key_id: process.env.RAZORPAY_KEY_ID, key_secret: process.env.RAZORPAY_KEY_SECRET }) : null;
const paymentKey = process.env.RAZORPAY_KEY_SECRET || '';
const appRoot = __dirname;
const loginAttempts = new Map();

if (appEnv === 'production' && configuredSessionSecret.length < 32) {
  throw new Error('Set SESSION_SECRET to a random value of at least 32 characters in production.');
}

app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '100kb' }));
app.use(morgan('tiny'));
app.use(express.static(path.join(appRoot, 'public')));

const clean = (value, limit = 250) => typeof value === 'string' ? value.trim().slice(0, limit) : '';
const publicUser = user => ({
  id: user.id, name: user.name, email: user.email,
  role: user.role === 'admin' && ADMIN_EMAIL && user.email === ADMIN_EMAIL ? 'admin' : 'customer',
  addresses: user.addresses || [], createdAt: user.createdAt
});
const digest = value => crypto.createHmac('sha256', SESSION_SECRET).update(value).digest('hex');
const secretMatches = (provided, expected) => {
  const actual = Buffer.from(provided);
  const configured = Buffer.from(expected);
  return actual.length === configured.length && actual.length > 0 && crypto.timingSafeEqual(actual, configured);
};

function passwordHash(password, salt = crypto.randomBytes(16).toString('hex')) {
  return `${salt}:${crypto.scryptSync(password, salt, 64).toString('hex')}`;
}

function checkPassword(password, stored) {
  const [salt, key] = String(stored || '').split(':');
  if (!salt || !key || !/^[a-f\d]{128}$/i.test(key)) return false;
  const actual = crypto.scryptSync(password, salt, 64);
  return crypto.timingSafeEqual(Buffer.from(key, 'hex'), actual);
}

function createSession(userId) {
  const value = crypto.randomBytes(32).toString('base64url');
  const session = { tokenHash: digest(value), userId, expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString() };
  return { value, session };
}

function auth(req, res, next) {
  const value = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!value) return res.status(401).json({ error: 'Please sign in to continue.' });
  const tokenHash = digest(value);
  const data = db.read();
  const session = data.sessions.find(item => {
    if (item.tokenHash) return item.tokenHash === tokenHash && new Date(item.expiresAt) > new Date();
    return item.token === value && new Date(item.expiresAt) > new Date();
  });
  if (!session) return res.status(401).json({ error: 'Please sign in to continue.' });
  req.user = data.users.find(user => user.id === session.userId);
  if (!req.user) return res.status(401).json({ error: 'Session expired.' });
  req.tokenHash = tokenHash;
  req.legacyToken = value;
  next();
}

function admin(req, res, next) {
  if (req.user.role !== 'admin' || !ADMIN_EMAIL || req.user.email !== ADMIN_EMAIL) {
    return res.status(403).json({ error: 'Administrator access required.' });
  }
  next();
}

function limitedAuth(req, res, next) {
  const key = `${req.ip}:${req.path}`;
  const now = Date.now();
  const attempt = loginAttempts.get(key);
  if (!attempt || attempt.resetAt <= now) {
    loginAttempts.set(key, { count: 1, resetAt: now + 15 * 60 * 1000 });
    return next();
  }
  if (attempt.count >= 10) return res.status(429).json({ error: 'Too many attempts. Please wait a little and try again.' });
  attempt.count += 1;
  next();
}

function getOrderLines(data, items) {
  if (!Array.isArray(items) || !items.length || items.length > 30) throw new Error('Your cart is empty.');
  return items.map(item => {
    const product = data.products.find(entry => entry.id === item.productId);
    const quantity = Number(item.quantity);
    if (!product || !Number.isInteger(quantity) || quantity < 1 || quantity > 10 || product.stock < quantity) {
      throw new Error(`${product?.name || 'A product'} is unavailable or has an invalid quantity.`);
    }
    return { productId: product.id, name: product.name, image: product.image, price: product.price, quantity };
  });
}

function validateAddress(input) {
  if (!input || !clean(input.name, 70) || !clean(input.phone, 20) || !clean(input.line1, 120) || !clean(input.city, 70) || !clean(input.postalCode, 15)) {
    throw new Error('Complete your name, phone, street address, city, and PIN code.');
  }
  return {
    id: input.id || db.id(),
    label: clean(input.label, 30) || 'Home',
    name: clean(input.name, 70),
    phone: clean(input.phone, 20),
    line1: clean(input.line1, 120),
    city: clean(input.city, 70),
    state: clean(input.state, 70),
    postalCode: clean(input.postalCode, 15)
  };
}

const subtotalOf = lines => lines.reduce((sum, item) => sum + item.price * item.quantity, 0);
const shippingFor = subtotal => subtotal >= 5000 ? 0 : 199;
const orderId = () => `ORD-${Date.now().toString().slice(-8)}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;

app.get('/api/health', (_, res) => res.json({ ok: true, razorpay: hasRazorpay }));
app.post('/api/newsletter', (req, res) => {
  const email = clean(req.body.email, 120).toLowerCase();
  if (!/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
  db.mutate(data => {
    data.subscribers ||= [];
    if (!data.subscribers.includes(email)) data.subscribers.push(email);
  });
  res.status(201).json({ subscribed: true });
});

app.get('/api/products', (req, res) => {
  const query = clean(req.query.q, 100).toLowerCase();
  const category = clean(req.query.category, 50);
  const sort = clean(req.query.sort, 20);
  const data = db.read();
  let products = data.products.filter(product =>
    (!category || product.category === category) &&
    (!query || `${product.name} ${product.category} ${product.description || ''}`.toLowerCase().includes(query))
  );
  if (sort === 'price-asc') products.sort((a, b) => a.price - b.price);
  if (sort === 'price-desc') products.sort((a, b) => b.price - a.price);
  if (sort === 'rating') products.sort((a, b) => b.rating - a.rating);
  res.json({ products, categories: [...new Set(data.products.map(product => product.category))] });
});

app.get('/api/products/:id', (req, res) => {
  const product = db.read().products.find(item => item.id === req.params.id);
  if (!product) return res.status(404).json({ error: 'Product not found.' });
  res.json({ product });
});

app.post('/api/auth/signup', limitedAuth, (req, res) => {
  const name = clean(req.body.name, 70);
  const email = clean(req.body.email, 120).toLowerCase();
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  if (name.length < 2) return res.status(400).json({ error: 'Enter your full name.' });
  if (!/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
  if (password.length < 8 || password.length > 128) return res.status(400).json({ error: 'Use a password between 8 and 128 characters.' });
  if (email === ADMIN_EMAIL && (!ADMIN_SETUP_TOKEN || !secretMatches(clean(req.body.adminSetupToken, 256), ADMIN_SETUP_TOKEN))) {
    return res.status(403).json({ error: 'The store administrator setup key is required for this email address.' });
  }
  try {
    const result = db.mutate(data => {
      if (data.users.some(user => user.email === email)) throw new Error('An account with that email already exists.');
      const user = {
        id: db.id(), name, email, password: passwordHash(password),
        role: email === ADMIN_EMAIL ? 'admin' : 'customer',
        addresses: [], createdAt: db.now()
      };
      const session = createSession(user.id);
      data.users.push(user);
      data.sessions.push(session.session);
      return { user: publicUser(user), token: session.value };
    });
    res.status(201).json(result);
  } catch (error) {
    res.status(409).json({ error: error.message });
  }
});

app.post('/api/auth/login', limitedAuth, (req, res) => {
  const email = clean(req.body.email, 120).toLowerCase();
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  if (password.length > 128) return res.status(400).json({ error: 'Password must be 128 characters or fewer.' });
  const result = db.mutate(data => {
    const user = data.users.find(entry => entry.email === email);
    if (!user || !checkPassword(password, user.password)) return null;
    const session = createSession(user.id);
    data.sessions = data.sessions.filter(entry => entry.userId !== user.id || new Date(entry.expiresAt) > new Date());
    data.sessions.push(session.session);
    return { token: session.value, user: publicUser(user) };
  });
  if (!result) return res.status(401).json({ error: 'Incorrect email or password.' });
  res.json(result);
});

app.post('/api/auth/logout', auth, (req, res) => {
  db.mutate(data => {
    data.sessions = data.sessions.filter(session => session.tokenHash !== req.tokenHash && session.token !== req.legacyToken);
  });
  res.status(204).end();
});

app.get('/api/me', auth, (req, res) => res.json({ user: publicUser(req.user) }));
app.put('/api/me/addresses', auth, (req, res) => {
  let address;
  try { address = validateAddress(req.body.address); }
  catch (error) { return res.status(400).json({ error: error.message }); }
  const user = db.mutate(data => {
    const current = data.users.find(entry => entry.id === req.user.id);
    const index = current.addresses.findIndex(entry => entry.id === address.id);
    if (index >= 0) current.addresses[index] = address;
    else current.addresses.push(address);
    return current;
  });
  res.json({ user: publicUser(user) });
});

app.get('/api/orders', auth, (req, res) => {
  const orders = db.read().orders
    .filter(order => req.user.role === 'admin' || order.userId === req.user.id)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json({ orders });
});

app.post('/api/orders/cod', auth, (req, res) => {
  try {
    const address = validateAddress(req.body.address);
    const order = db.mutate(data => {
      const lines = getOrderLines(data, req.body.items);
      const subtotal = subtotalOf(lines);
      lines.forEach(line => { data.products.find(product => product.id === line.productId).stock -= line.quantity; });
      const createdAt = db.now();
      const result = {
        id: orderId(), userId: req.user.id, items: lines, subtotal,
        shipping: shippingFor(subtotal), total: subtotal + shippingFor(subtotal),
        status: 'Confirmed', paymentStatus: 'Cash on delivery', address, createdAt,
        timeline: [{ label: 'Order confirmed', at: createdAt }]
      };
      data.orders.push(result);
      return result;
    });
    res.status(201).json({ order });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/payments/create-order', auth, async (req, res) => {
  if (!hasRazorpay) return res.status(503).json({ error: 'Online payments are not configured. Add Razorpay test keys in .env.' });
  try {
    const address = validateAddress(req.body.address);
    const lines = getOrderLines(db.read(), req.body.items);
    const subtotal = subtotalOf(lines);
    const amount = subtotal + shippingFor(subtotal);
    const receipt = `rcpt_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
    const razorpayOrder = await razorpay.orders.create({ amount: amount * 100, currency: 'INR', receipt, notes: { userId: req.user.id } });
    db.mutate(data => data.paymentRefs.push({
      razorpayOrderId: razorpayOrder.id, userId: req.user.id, items: lines,
      subtotal, amount, address, used: false, createdAt: db.now()
    }));
    res.json({ order: razorpayOrder, key: process.env.RAZORPAY_KEY_ID });
  } catch (error) {
    res.status(400).json({ error: error.message || 'Could not start payment.' });
  }
});

app.post('/api/payments/verify', auth, (req, res) => {
  const orderIdFromGateway = clean(req.body.razorpay_order_id, 100);
  const paymentId = clean(req.body.razorpay_payment_id, 100);
  const signature = clean(req.body.razorpay_signature, 256);
  if (!hasRazorpay || !orderIdFromGateway || !paymentId || !/^[a-f\d]{64}$/i.test(signature)) {
    return res.status(400).json({ error: 'Payment signature could not be verified.' });
  }
  const expected = crypto.createHmac('sha256', paymentKey).update(`${orderIdFromGateway}|${paymentId}`).digest();
  const actual = Buffer.from(signature, 'hex');
  if (actual.length !== expected.length || !crypto.timingSafeEqual(expected, actual)) {
    return res.status(400).json({ error: 'Payment signature could not be verified.' });
  }
  try {
    const order = db.mutate(data => {
      const reference = data.paymentRefs.find(entry => entry.razorpayOrderId === orderIdFromGateway && entry.userId === req.user.id);
      if (!reference || reference.used) throw new Error('This payment has already been processed or is not valid.');
      const lines = getOrderLines(data, reference.items);
      reference.used = true;
      lines.forEach(line => { data.products.find(product => product.id === line.productId).stock -= line.quantity; });
      const createdAt = db.now();
      const result = {
        id: orderId(), userId: req.user.id, items: lines, subtotal: reference.subtotal,
        shipping: shippingFor(reference.subtotal), total: reference.amount,
        status: 'Confirmed', paymentStatus: 'Paid', paymentId, address: reference.address, createdAt,
        timeline: [{ label: 'Payment verified', at: createdAt }, { label: 'Order confirmed', at: createdAt }]
      };
      data.orders.push(result);
      return result;
    });
    res.json({ order });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get('/api/admin/stats', auth, admin, (req, res) => {
  const data = db.read();
  res.json({ stats: {
    revenue: data.orders.filter(order => order.paymentStatus === 'Paid').reduce((sum, order) => sum + order.total, 0),
    orders: data.orders.length,
    customers: data.users.filter(user => user.role === 'customer').length,
    products: data.products.length
  } });
});

app.post('/api/admin/products', auth, admin, (req, res) => {
  const body = req.body;
  const product = {
    id: db.id(), name: clean(body.name, 100), category: clean(body.category, 50),
    price: Number(body.price), oldPrice: Number(body.oldPrice) || Number(body.price),
    rating: 4.8, reviews: 0, stock: Number(body.stock), badge: clean(body.badge, 30) || 'New',
    image: clean(body.image, 600), description: clean(body.description, 600)
  };
  if (!product.name || !product.category || !Number.isSafeInteger(product.price) || product.price < 1 ||
      !Number.isSafeInteger(product.stock) || product.stock < 0 || !/^https:\/\//i.test(product.image)) {
    return res.status(400).json({ error: 'Provide a name, category, whole-number price and stock, and a secure HTTPS image URL.' });
  }
  db.mutate(data => data.products.unshift(product));
  res.status(201).json({ product });
});

app.patch('/api/admin/products/:id', auth, admin, (req, res) => {
  const price = Number(req.body.price);
  const stock = Number(req.body.stock);
  if (!Number.isSafeInteger(price) || price < 1 || !Number.isSafeInteger(stock) || stock < 0) {
    return res.status(400).json({ error: 'Price must be a positive whole number and inventory cannot be negative.' });
  }
  try {
    const product = db.mutate(data => {
      const current = data.products.find(entry => entry.id === req.params.id);
      if (!current) throw new Error('Product not found.');
      current.price = price;
      current.stock = stock;
      return current;
    });
    res.json({ product });
  } catch (error) {
    res.status(404).json({ error: error.message });
  }
});

app.patch('/api/admin/orders/:id', auth, admin, (req, res) => {
  const allowed = ['Confirmed', 'Processing', 'Shipped', 'Delivered', 'Cancelled'];
  const status = clean(req.body.status, 30);
  if (!allowed.includes(status)) return res.status(400).json({ error: 'Invalid order status.' });
  try {
    const order = db.mutate(data => {
      const current = data.orders.find(entry => entry.id === req.params.id);
      if (!current) throw new Error('Order not found.');
      if (current.status !== status) {
        current.status = status;
        current.timeline.push({ label: status, at: db.now() });
      }
      return current;
    });
    res.json({ order });
  } catch (error) {
    res.status(404).json({ error: error.message });
  }
});

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));
app.use((error, req, res, next) => {
  if (error.status === 400 && error.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Request body must be valid JSON.' });
  }
  if (error.status === 413) return res.status(413).json({ error: 'Request body is too large.' });
  console.error(error);
  res.status(500).json({ error: 'Something went wrong. Please try again.' });
});

app.listen(PORT, () => console.log(`Aurora Commerce running on http://localhost:${PORT}`));
