(() => {
  function readStorage(key, fallback) {
    try { const value = JSON.parse(localStorage.getItem(key)); return Array.isArray(value) ? value : fallback; }
    catch { return fallback; }
  }

  const state = {
    products: [], categories: [], category: '', query: '', sort: 'featured',
    cart: readStorage('aurora-cart', []), wishlist: readStorage('aurora-wishlist', []),
    token: localStorage.getItem('aurora-token') || '', user: null, orders: [],
    dialogMode: 'login', lastFocus: null
  };
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const money = value => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(Number(value) || 0);
  const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  async function api(path, options = {}) {
    const headers = { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}), ...options.headers };
    let response;
    try {
      response = await fetch(path, { ...options, headers, body: options.body ? JSON.stringify(options.body) : undefined });
    } catch {
      throw new Error('We could not reach the store. Check your connection and try again.');
    }
    if (response.status === 401 && state.token && path !== '/api/auth/login' && path !== '/api/auth/signup') {
      clearSession();
    }
    if (response.status === 204) return null;
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Something went wrong. Please try again.');
    return data;
  }

  function persist() {
    localStorage.setItem('aurora-cart', JSON.stringify(state.cart));
    localStorage.setItem('aurora-wishlist', JSON.stringify(state.wishlist));
  }

  function toast(message, type = 'success') {
    const node = document.createElement('div');
    node.className = `toast${type === 'error' ? ' error' : ''}`;
    node.textContent = message;
    $('#toast-region').append(node);
    window.setTimeout(() => node.remove(), 3400);
  }

  function setLoadingGrid() {
    $('#product-grid').innerHTML = Array.from({ length: 4 }, () => '<div class="loading-card" aria-hidden="true"></div>').join('');
  }

  async function loadProducts() {
    setLoadingGrid();
    const params = new URLSearchParams();
    if (state.query) params.set('q', state.query);
    if (state.category && state.category !== 'Wishlist') params.set('category', state.category);
    if (state.sort) params.set('sort', state.sort);
    try {
      const data = await api(`/api/products?${params}`);
      state.categories = data.categories || [];
      state.products = data.products || [];
      renderCategories();
      renderProducts();
    } catch (error) {
      $('#product-grid').innerHTML = `<div class="empty-state"><b>We couldn't load the collection.</b><p>${escapeHtml(error.message)}</p><button class="text-link" id="retry-products">Try again ↻</button></div>`;
    }
  }

  function renderCategories() {
    const items = ['Everything', ...state.categories, 'Wishlist'];
    $('#category-list').innerHTML = items.map(category => `<button class="filter-chip${(state.category || 'Everything') === category ? ' active' : ''}" data-category-filter="${escapeHtml(category)}">${escapeHtml(category)}</button>`).join('');
  }

  function renderProducts() {
    const products = state.category === 'Wishlist'
      ? state.products.filter(product => state.wishlist.includes(product.id))
      : state.products;
    $('#product-count').textContent = `${products.length} ${products.length === 1 ? 'GOOD THING' : 'GOOD THINGS'}`;
    if (!products.length) {
      $('#product-grid').innerHTML = `<div class="empty-state"><b>${state.category === 'Wishlist' ? 'Your wishlist is waiting.' : 'Nothing here just yet.'}</b><p>${state.category === 'Wishlist' ? 'Tap the little heart on anything you love.' : 'Try a different search or collection.'}</p></div>`;
      return;
    }
    $('#product-grid').innerHTML = products.map((product, index) => {
      const wished = state.wishlist.includes(product.id);
      return `<article class="product-card" style="animation-delay:${Math.min(index * 45, 260)}ms">
        <div class="product-picture" data-product="${escapeHtml(product.id)}">
          <img src="${escapeHtml(product.image)}" alt="${escapeHtml(product.name)}" loading="lazy">
          <span class="product-badge">${escapeHtml(product.badge || 'Considered')}</span>
          <button class="wish-button${wished ? ' is-wished' : ''}" data-wish="${escapeHtml(product.id)}" aria-label="${wished ? 'Remove from' : 'Add to'} wishlist" aria-pressed="${wished}">${wished ? '♥' : '♡'}</button>
          <button class="quick-add" data-add="${escapeHtml(product.id)}"><span>Add to bag</span><b>+</b></button>
        </div>
        <div class="product-meta"><span class="product-category">${escapeHtml(product.category)}</span><h3><button class="product-name-button" data-product="${escapeHtml(product.id)}">${escapeHtml(product.name)}</button></h3><div class="product-foot"><span class="product-price">${money(product.price)}${product.oldPrice > product.price ? `<span class="old-price">${money(product.oldPrice)}</span>` : ''}</span><span class="rating"><span>★</span> ${Number(product.rating).toFixed(1)} <small>(${Number(product.reviews) || 0})</small></span></div></div>
      </article>`;
    }).join('');
  }

  function updateBagCount() {
    const count = state.cart.reduce((sum, line) => sum + line.quantity, 0);
    $('#bag-count').textContent = count;
    $('#drawer-count').textContent = `(${count})`;
  }

  function addToCart(productId) {
    const product = state.products.find(item => item.id === productId);
    if (!product) return;
    const line = state.cart.find(item => item.productId === productId);
    const current = line?.quantity || 0;
    if (current >= Math.min(10, Number(product.stock) || 0)) return toast('That’s all the available stock for now.', 'error');
    if (line) line.quantity += 1;
    else state.cart.push({ productId, quantity: 1 });
    persist();
    updateBagCount();
    renderCart();
    toast(`${product.name} is in your bag.`);
  }

  function changeQuantity(productId, delta) {
    const line = state.cart.find(item => item.productId === productId);
    const product = state.products.find(item => item.id === productId);
    if (!line) return;
    const next = line.quantity + delta;
    if (next > Math.min(10, Number(product?.stock) || 0)) return toast('That’s all the available stock for now.', 'error');
    if (next < 1) state.cart = state.cart.filter(item => item.productId !== productId);
    else line.quantity = next;
    persist();
    updateBagCount();
    renderCart();
  }

  function cartDetails() {
    const lines = state.cart.map(line => ({ ...line, product: state.products.find(product => product.id === line.productId) })).filter(line => line.product);
    const subtotal = lines.reduce((sum, line) => sum + Number(line.product.price) * line.quantity, 0);
    return { lines, subtotal, shipping: subtotal === 0 || subtotal >= 5000 ? 0 : 199, count: lines.reduce((sum, line) => sum + line.quantity, 0) };
  }

  function renderCart() {
    const { lines, subtotal, shipping, count } = cartDetails();
    updateBagCount();
    if (!lines.length) {
      $('#cart-content').innerHTML = '<div class="empty-state"><b>A little room for something good.</b><p>Your bag is empty for now.<br>We think you’ll find something to love.</p><button class="text-link" data-close-drawer>Explore the collection ↗</button></div>';
      $('#cart-footer').innerHTML = '';
      return;
    }
    $('#cart-content').innerHTML = lines.map(({ product, quantity }) => `<article class="cart-line"><img src="${escapeHtml(product.image)}" alt=""><div><h3>${escapeHtml(product.name)}</h3><p>${escapeHtml(product.category)}</p><div class="quantity-control"><button data-quantity="${escapeHtml(product.id)}" data-delta="-1" aria-label="Reduce quantity">−</button><span>${quantity}</span><button data-quantity="${escapeHtml(product.id)}" data-delta="1" aria-label="Increase quantity">+</button></div></div><div><span class="line-price">${money(product.price * quantity)}</span><button class="remove-item" data-remove="${escapeHtml(product.id)}">Remove</button></div></article>`).join('');
    const remaining = Math.max(0, 5000 - subtotal);
    const progress = Math.min(100, subtotal / 5000 * 100);
    $('#cart-footer').innerHTML = `<div class="shipping-note">${remaining ? `You’re ${money(remaining)} away from complimentary shipping.` : 'Complimentary shipping is on us.'}<div class="shipping-meter"><span style="width:${progress}%"></span></div></div><div class="subtotal-row"><span>Subtotal · ${count} ${count === 1 ? 'item' : 'items'}</span><span>${money(subtotal)}</span></div><div class="subtotal-row"><span>Shipping</span><span>${shipping ? money(shipping) : 'Complimentary'}</span></div><div class="subtotal-row total"><span>Total</span><span>${money(subtotal + shipping)}</span></div><button class="button button-lime" id="checkout-trigger">Continue to checkout <span>↗</span></button><small>Taxes included · Secure checkout</small>`;
  }

  function openDrawer() {
    renderCart();
    $('#drawer-scrim').classList.add('open');
    $('#cart-drawer').classList.add('open');
    $('#cart-drawer').setAttribute('aria-hidden', 'false');
    document.body.classList.add('locked');
  }

  function closeDrawer() {
    $('#drawer-scrim').classList.remove('open');
    $('#cart-drawer').classList.remove('open');
    $('#cart-drawer').setAttribute('aria-hidden', 'true');
    document.body.classList.remove('locked');
  }

  function openDialog(content, label = 'Aurora dialog', variant = '') {
    state.lastFocus = document.activeElement;
    $('#dialog-content').innerHTML = content;
    $('#dialog').setAttribute('aria-label', label);
    $('#dialog').classList.toggle('auth-dialog', variant === 'auth');
    $('#modal-backdrop').classList.add('open');
    document.body.classList.add('locked');
    window.setTimeout(() => $('.dialog input, .dialog button, .dialog select')?.focus(), 80);
  }

  function closeDialog() {
    $('#modal-backdrop').classList.remove('open');
    $('#dialog').classList.remove('auth-dialog');
    document.body.classList.remove('locked');
    if (state.lastFocus?.focus) state.lastFocus.focus();
  }

  function showProduct(productId) {
    const product = state.products.find(item => item.id === productId);
    if (!product) return;
    openDialog(`<div class="product-dialog"><img src="${escapeHtml(product.image)}" alt="${escapeHtml(product.name)}"><div><span class="product-category">${escapeHtml(product.category)} · ${escapeHtml(product.badge || '')}</span><h2>${escapeHtml(product.name)}</h2><div class="dialog-price">${money(product.price)}${product.oldPrice > product.price ? `<del>${money(product.oldPrice)}</del>` : ''}</div><p>${escapeHtml(product.description)}</p><div class="rating"><span>★</span> ${Number(product.rating).toFixed(1)} · ${Number(product.reviews) || 0} considered opinions</div><div class="stock-note">${product.stock > 0 ? `${product.stock} in stock · Ships with care` : 'Currently out of stock'}</div><button class="button button-lime" data-add="${escapeHtml(product.id)}" ${product.stock < 1 ? 'disabled' : ''}>Add to bag <span>↗</span></button></div></div>`, product.name);
  }

  function authMarkup(mode = 'login', error = '', message = '') {
    const signup = mode === 'signup';
    return `<div class="auth-shell">
      <div class="auth-visual"><span class="auth-wordmark">aurora<sup>®</sup></span><span class="auth-kicker">A MORE CONSIDERED EVERYDAY</span><h3>Good things<br><em>come back around.</em></h3><p>A place for the things you love, and the little details that make them yours.</p><span class="auth-orbit">✳</span><small>MADE FOR LIVING. MADE TO LAST.</small></div>
      <div class="auth-content"><div class="eyebrow"><span></span> WELCOME TO AURORA</div><h2>${signup ? 'A good place to begin.' : 'Good to see you again.'}</h2><p class="dialog-subtitle">${signup ? 'Create an account to keep the things you love close.' : 'Sign in to pick up right where you left off.'}</p>
        <div class="auth-tabs"><button class="auth-tab${!signup ? ' active' : ''}" data-auth-mode="login">Sign in</button><button class="auth-tab${signup ? ' active' : ''}" data-auth-mode="signup">Create account</button></div>
        <form id="auth-form" novalidate>
          ${signup ? '<label class="form-field"><span>Your name</span><input name="name" autocomplete="name" minlength="2" maxlength="70" required placeholder="How should we call you?"></label>' : ''}
          <label class="form-field"><span>Email address</span><input name="email" type="email" autocomplete="email" maxlength="120" required placeholder="you@example.com"></label>
          <label class="form-field"><span>Password</span><div class="password-wrap"><input name="password" type="password" autocomplete="${signup ? 'new-password' : 'current-password'}" minlength="${signup ? '8' : '1'}" required placeholder="${signup ? 'At least 8 characters' : 'Your password'}"><button type="button" class="password-toggle" data-password-toggle>Show</button></div></label>
          ${signup ? '<label class="form-field"><span>Store setup key · owners only</span><input name="adminSetupToken" type="password" autocomplete="off" maxlength="256" placeholder="Leave blank for a customer account"></label>' : ''}
          ${message ? `<div class="form-success">${escapeHtml(message)}</div>` : ''}${error ? `<div class="form-error" role="alert">${escapeHtml(error)}</div>` : ''}
          ${!signup ? '<button type="button" class="forgot-link" data-forgot>Forgot your password?</button>' : ''}
          <button class="button button-lime form-submit" type="submit">${signup ? 'Create your account' : 'Sign in securely'} <span>↗</span></button><p class="form-note">${signup ? 'The setup key is only needed to create the configured store administrator.' : 'Your details stay yours. Always.'}</p>
        </form>
      </div>
    </div>`;
  }

  function showAuth(mode = 'login', error = '', message = '') {
    state.dialogMode = mode;
    openDialog(authMarkup(mode, error, message), 'Sign in or create an Aurora account', 'auth');
  }

  async function submitAuth(form) {
    const data = new FormData(form);
    const mode = state.dialogMode;
    const body = { email: String(data.get('email') || '').trim(), password: String(data.get('password') || '') };
    if (mode === 'signup') {
      body.name = String(data.get('name') || '').trim();
      body.adminSetupToken = String(data.get('adminSetupToken') || '');
    }
    if (!/^\S+@\S+\.\S+$/.test(body.email)) return showAuth(mode, 'Enter a valid email address.');
    if (body.password.length < (mode === 'signup' ? 8 : 1)) return showAuth(mode, 'Use at least 8 characters for your password.');
    const submit = $('button[type="submit"]', form);
    submit.disabled = true;
    submit.textContent = mode === 'signup' ? 'Creating your account…' : 'Signing you in…';
    try {
      const result = await api(`/api/auth/${mode}`, { method: 'POST', body });
      state.token = result.token;
      state.user = result.user;
      localStorage.setItem('aurora-token', state.token);
      closeDialog();
      toast(`Welcome${state.user.name ? `, ${state.user.name.split(' ')[0]}` : ''}.`);
      await refreshUser();
    } catch (error) {
      showAuth(mode, error.message);
    }
  }

  function clearSession() {
    state.token = '';
    state.user = null;
    state.orders = [];
    localStorage.removeItem('aurora-token');
  }

  async function refreshUser() {
    if (!state.token) return;
    try {
      const result = await api('/api/me');
      state.user = result.user;
    } catch {
      clearSession();
    }
  }

  async function showAccount() {
    if (!state.user) return showAuth('login');
    try {
      const result = await api('/api/orders');
      state.orders = result.orders || [];
    } catch (error) {
      return toast(error.message, 'error');
    }
    const addresses = state.user.addresses || [];
    openDialog(`<div class="eyebrow"><span></span> YOUR AURORA</div><h2>Hello, ${escapeHtml(state.user.name.split(' ')[0])}.</h2><p class="dialog-subtitle">${escapeHtml(state.user.email)} · ${state.user.role === 'admin' ? 'Administrator' : 'Aurora member'}</p>${state.user.role === 'admin' ? '<button class="button button-lime form-submit" id="admin-open">Open the studio dashboard ↗</button>' : ''}<h3 class="account-section-title">Your orders · ${state.orders.length}</h3>${state.orders.length ? state.orders.map(orderMarkup).join('') : '<p class="dialog-subtitle">Your first order will feel right at home here.</p>'}<h3 class="account-section-title">Saved addresses · ${addresses.length}</h3>${addresses.length ? addresses.map(address => `<div class="order-card"><b>${escapeHtml(address.label)}</b><p class="dialog-subtitle">${escapeHtml(address.name)} · ${escapeHtml(address.line1)}, ${escapeHtml(address.city)} ${escapeHtml(address.postalCode)}</p></div>`).join('') : '<p class="dialog-subtitle">Your delivery addresses will appear here after checkout.</p>'}<button class="button button-outline form-submit" id="logout-button" style="color:var(--ink);border-color:var(--line)">Sign out</button>`, 'Your Aurora account');
  }

  function orderMarkup(order) {
    const items = (order.items || []).map(item => `${item.quantity} × ${escapeHtml(item.name)}`).join('<br>');
    const latest = order.timeline?.[order.timeline.length - 1]?.label || order.status;
    return `<article class="order-card"><div class="order-card-head"><b>${escapeHtml(order.id)}</b><span class="order-status">${escapeHtml(order.status)}</span></div><div class="order-items">${items}</div><div class="order-card-head"><span>${new Date(order.createdAt).toLocaleDateString('en-IN', { year: 'numeric', month: 'short', day: 'numeric' })} · ${escapeHtml(order.paymentStatus)}</span><b>${money(order.total)}</b></div><div class="order-timeline">Tracking · ${escapeHtml(latest)}</div></article>`;
  }

  function checkoutMarkup(error = '') {
    const addresses = state.user?.addresses || [];
    const address = addresses[0] || {};
    const { subtotal, shipping } = cartDetails();
    return `<div class="eyebrow"><span></span> A GOOD THING, ON ITS WAY</div><h2>Delivery details.</h2><p class="dialog-subtitle">A few details to make sure it finds its way home.</p><form id="checkout-form" novalidate><div class="field-grid"><label class="form-field"><span>Full name *</span><input name="name" required maxlength="70" autocomplete="name" value="${escapeHtml(address.name || state.user?.name || '')}" placeholder="Your name"></label><label class="form-field"><span>Phone number *</span><input name="phone" required maxlength="20" autocomplete="tel" value="${escapeHtml(address.phone || '')}" placeholder="+91 98765 43210"></label></div><label class="form-field"><span>Street address *</span><input name="line1" required maxlength="120" autocomplete="street-address" value="${escapeHtml(address.line1 || '')}" placeholder="House number and street"></label><div class="field-grid"><label class="form-field"><span>City *</span><input name="city" required maxlength="70" autocomplete="address-level2" value="${escapeHtml(address.city || '')}" placeholder="City"></label><label class="form-field"><span>State</span><input name="state" maxlength="70" autocomplete="address-level1" value="${escapeHtml(address.state || '')}" placeholder="State"></label></div><div class="field-grid"><label class="form-field"><span>PIN code *</span><input name="postalCode" required maxlength="15" autocomplete="postal-code" value="${escapeHtml(address.postalCode || '')}" placeholder="PIN code"></label><label class="form-field"><span>Address label</span><select name="label"><option${address.label === 'Home' ? ' selected' : ''}>Home</option><option${address.label === 'Work' ? ' selected' : ''}>Work</option><option${address.label === 'Other' ? ' selected' : ''}>Other</option></select></label></div>${error ? `<div class="form-error" role="alert">${escapeHtml(error)}</div>` : ''}<div class="subtotal-row"><span>Items · shipping ${shipping ? money(shipping) : 'complimentary'}</span><b>${money(subtotal + shipping)}</b></div><button class="button button-lime form-submit" type="submit" data-payment="cod">Place cash-on-delivery order <span>↗</span></button><button class="button button-outline form-submit" type="submit" data-payment="razorpay" style="color:var(--ink);border-color:var(--line)">Pay online with Razorpay ↗</button><p class="form-note">Your payment is processed securely by Razorpay. Online payment is available when the store owner configures test/live keys.</p></form>`;
  }

  function startCheckout() {
    if (!state.cart.length) return;
    if (!state.user) {
      closeDrawer();
      return showAuth('login', '', 'Sign in before checking out. Your bag will be here.');
    }
    closeDrawer();
    openDialog(checkoutMarkup(), 'Checkout and delivery address');
  }

  function getCheckoutPayload(form) {
    const data = new FormData(form);
    return { address: { label: String(data.get('label') || 'Home'), name: String(data.get('name') || '').trim(), phone: String(data.get('phone') || '').trim(), line1: String(data.get('line1') || '').trim(), city: String(data.get('city') || '').trim(), state: String(data.get('state') || '').trim(), postalCode: String(data.get('postalCode') || '').trim() }, items: state.cart.map(({ productId, quantity }) => ({ productId, quantity })) };
  }

  async function saveAddress(address) {
    const result = await api('/api/me/addresses', { method: 'PUT', body: { address } });
    state.user = result.user;
  }

  async function submitCheckout(form, method) {
    if (!form.reportValidity()) return;
    const payload = getCheckoutPayload(form);
    const submit = $(`button[data-payment="${method}"]`, form);
    const other = $$('button[data-payment]', form);
    other.forEach(button => { button.disabled = true; });
    submit.textContent = method === 'cod' ? 'Placing your order…' : 'Preparing secure payment…';
    try {
      await saveAddress(payload.address);
      if (method === 'cod') {
        const result = await api('/api/orders/cod', { method: 'POST', body: payload });
        finishOrder(result.order);
      } else {
        await startRazorpay(payload);
      }
    } catch (error) {
      showCheckoutError(error.message);
    }
  }

  function showCheckoutError(message) {
    openDialog(checkoutMarkup(message), 'Checkout and delivery address');
  }

  async function startRazorpay(payload) {
    const { order, key } = await api('/api/payments/create-order', { method: 'POST', body: payload });
    if (!window.Razorpay) {
      await new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = 'https://checkout.razorpay.com/v1/checkout.js';
        script.onload = resolve;
        script.onerror = () => reject(new Error('Secure payment checkout could not be loaded. Try again or choose cash on delivery.'));
        document.head.append(script);
      });
    }
    const checkout = new window.Razorpay({
      key,
      amount: order.amount,
      currency: order.currency,
      name: 'Aurora',
      description: 'Objects for a life well considered',
      order_id: order.id,
      prefill: { name: payload.address.name, email: state.user.email, contact: payload.address.phone },
      theme: { color: '#a6c851' },
      handler: async response => {
        try {
          const result = await api('/api/payments/verify', { method: 'POST', body: response });
          finishOrder(result.order);
        } catch (error) {
          showCheckoutError(`${error.message} If you were charged, contact the store with your Razorpay payment ID.`);
        }
      },
      modal: { ondismiss: () => toast('Payment wasn’t completed. Your bag is still saved.', 'error') }
    });
    checkout.open();
  }

  function finishOrder(order) {
    state.cart = [];
    persist();
    updateBagCount();
    closeDialog();
    renderCart();
    toast(`Order ${order.id} is confirmed. Thank you.`);
    showAccount();
  }

  async function showAdmin() {
    try {
      const [statsData, orderData, productData] = await Promise.all([api('/api/admin/stats'), api('/api/orders'), api('/api/products')]);
      const stats = statsData.stats;
      const orders = orderData.orders || [];
      state.products = productData.products || state.products;
      openDialog(`<div class="eyebrow"><span></span> THE AURORA STUDIO</div><h2>Good morning, admin.</h2><p class="dialog-subtitle">A considered view of how things are going.</p><div class="admin-stats"><div class="stat-card"><b>${money(stats.revenue)}</b><span>Paid revenue</span></div><div class="stat-card"><b>${stats.orders}</b><span>Orders</span></div><div class="stat-card"><b>${stats.customers}</b><span>Customers</span></div></div><h3 class="account-section-title">Add a considered thing</h3><form id="product-form"><div class="field-grid"><label class="form-field"><span>Name *</span><input name="name" required maxlength="100"></label><label class="form-field"><span>Category *</span><input name="category" required maxlength="50" placeholder="Living, Tech…"></label></div><div class="field-grid"><label class="form-field"><span>Price in ₹ *</span><input name="price" type="number" min="1" step="1" required></label><label class="form-field"><span>Previous price in ₹</span><input name="oldPrice" type="number" min="0" step="1"></label></div><div class="field-grid"><label class="form-field"><span>Inventory *</span><input name="stock" type="number" min="0" step="1" required></label><label class="form-field"><span>Badge</span><input name="badge" maxlength="30" placeholder="New arrival"></label></div><label class="form-field"><span>Image URL *</span><input name="image" type="url" required maxlength="600" placeholder="https://…"></label><label class="form-field"><span>Description</span><textarea name="description" maxlength="600"></textarea></label><button class="button button-lime form-submit" type="submit">Add to the collection ↗</button></form><h3 class="account-section-title">Inventory · update price & stock</h3><div>${state.products.map(product => `<form class="inventory-form" data-inventory="${escapeHtml(product.id)}"><span><b>${escapeHtml(product.name)}</b><small>${escapeHtml(product.category)}</small></span><label><span>₹</span><input name="price" aria-label="${escapeHtml(product.name)} price" type="number" min="1" step="1" value="${Number(product.price)}" required></label><label><span>Qty</span><input name="stock" aria-label="${escapeHtml(product.name)} stock" type="number" min="0" step="1" value="${Number(product.stock)}" required></label><button class="text-link" type="submit">Save</button></form>`).join('')}</div><h3 class="account-section-title">Orders · update fulfillment</h3>${orders.length ? orders.map(order => `<div class="admin-order"><span><b>${escapeHtml(order.id)}</b><br>${money(order.total)} · ${escapeHtml(order.status)}</span><select aria-label="Update ${escapeHtml(order.id)} status" data-order-status="${escapeHtml(order.id)}">${['Confirmed', 'Processing', 'Shipped', 'Delivered', 'Cancelled'].map(status => `<option${order.status === status ? ' selected' : ''}>${status}</option>`).join('')}</select></div>`).join('') : '<p class="dialog-subtitle">New orders will show up here.</p>'}`, 'Aurora administration studio');
    } catch (error) {
      toast(error.message, 'error');
    }
  }

  async function saveProduct(form) {
    const data = new FormData(form);
    const body = Object.fromEntries(data.entries());
    body.price = Number(body.price);
    body.oldPrice = Number(body.oldPrice) || body.price;
    body.stock = Number(body.stock);
    const button = $('button[type="submit"]', form);
    button.disabled = true;
    try {
      await api('/api/admin/products', { method: 'POST', body });
      toast('A new thing joins the collection.');
      await loadProducts();
      await showAdmin();
    } catch (error) {
      button.disabled = false;
      toast(error.message, 'error');
    }
  }

  async function saveInventory(form) {
    const body = Object.fromEntries(new FormData(form).entries());
    body.price = Number(body.price);
    body.stock = Number(body.stock);
    try {
      await api(`/api/admin/products/${encodeURIComponent(form.dataset.inventory)}`, { method: 'PATCH', body });
      toast('Inventory updated.');
      await loadProducts();
      await showAdmin();
    } catch (error) {
      toast(error.message, 'error');
    }
  }

  function toggleWishlist(productId) {
    state.wishlist = state.wishlist.includes(productId) ? state.wishlist.filter(id => id !== productId) : [...state.wishlist, productId];
    persist();
    renderProducts();
    toast(state.wishlist.includes(productId) ? 'Saved for another day.' : 'Removed from your wishlist.');
  }

  function debounce(callback, wait) {
    let timer;
    return (...args) => { window.clearTimeout(timer); timer = window.setTimeout(() => callback(...args), wait); };
  }

  function attachEvents() {
    $('#product-grid').addEventListener('click', event => {
      const target = event.target.closest('[data-add], [data-wish], [data-product]');
      if (!target) return;
      if (target.dataset.add) { event.stopPropagation(); addToCart(target.dataset.add); }
      else if (target.dataset.wish) { event.stopPropagation(); toggleWishlist(target.dataset.wish); }
      else if (target.dataset.product) showProduct(target.dataset.product);
    });
    $('#category-list').addEventListener('click', event => {
      const button = event.target.closest('[data-category-filter]');
      if (!button) return;
      state.category = button.dataset.categoryFilter === 'Everything' ? '' : button.dataset.categoryFilter;
      loadProducts();
    });
    $('#search-input').addEventListener('input', debounce(event => { state.query = event.target.value.trim(); loadProducts(); }, 220));
    $('#sort-select').addEventListener('change', event => { state.sort = event.target.value; loadProducts(); });
    $('#clear-filters').addEventListener('click', () => {
      state.category = ''; state.query = ''; state.sort = 'featured';
      $('#search-input').value = ''; $('#sort-select').value = 'featured'; loadProducts();
    });
    $('#search-toggle').addEventListener('click', () => { $('#search-input').focus(); $('#shop').scrollIntoView({ behavior: 'smooth' }); });
    $('#cart-trigger').addEventListener('click', openDrawer);
    $('#drawer-scrim').addEventListener('click', closeDrawer);
    $('.close-drawer').addEventListener('click', closeDrawer);
    $('#cart-drawer').addEventListener('click', event => {
      if (event.target.closest('[data-close-drawer]')) return closeDrawer();
      if (event.target.closest('#checkout-trigger')) return startCheckout();
      const quantity = event.target.closest('[data-quantity]');
      if (quantity) return changeQuantity(quantity.dataset.quantity, Number(quantity.dataset.delta));
      const remove = event.target.closest('[data-remove]');
      if (remove) { state.cart = state.cart.filter(line => line.productId !== remove.dataset.remove); persist(); renderCart(); }
    });
    $('#account-button').addEventListener('click', showAccount);
    $('#modal-backdrop').addEventListener('click', event => { if (event.target === $('#modal-backdrop')) closeDialog(); });
    $('#dialog-close').addEventListener('click', closeDialog);
    $('#dialog-content').addEventListener('click', async event => {
      const mode = event.target.closest('[data-auth-mode]');
      if (mode) return showAuth(mode.dataset.authMode);
      const toggle = event.target.closest('[data-password-toggle]');
      if (toggle) {
        const input = toggle.parentElement.querySelector('input');
        input.type = input.type === 'password' ? 'text' : 'password';
        toggle.textContent = input.type === 'password' ? 'Show' : 'Hide';
      }
      if (event.target.closest('[data-forgot]')) {
        showAuth('login', '', 'Password reset is not enabled yet. Please contact the store owner for help.');
      }
      if (event.target.closest('#admin-open')) await showAdmin();
      if (event.target.closest('#logout-button')) {
        try { await api('/api/auth/logout', { method: 'POST' }); } catch (error) { toast(error.message, 'error'); }
        clearSession(); closeDialog(); toast('You’re signed out. See you soon.');
      }
      if (event.target.closest('[data-add]')) {
        const id = event.target.closest('[data-add]').dataset.add;
        closeDialog(); addToCart(id);
      }
    });
    $('#dialog-content').addEventListener('submit', async event => {
      event.preventDefault();
      const form = event.target;
      if (form.id === 'auth-form') return submitAuth(form);
      if (form.id === 'checkout-form') {
        const method = event.submitter?.dataset.payment || 'cod';
        return submitCheckout(form, method);
      }
      if (form.id === 'product-form') return saveProduct(form);
      if (form.matches('.inventory-form')) return saveInventory(form);
    });
    $('#dialog-content').addEventListener('change', async event => {
      const select = event.target.closest('[data-order-status]');
      if (!select) return;
      try {
        await api(`/api/admin/orders/${encodeURIComponent(select.dataset.orderStatus)}`, { method: 'PATCH', body: { status: select.value } });
        toast('Order status updated.');
      } catch (error) {
        toast(error.message, 'error');
        await showAdmin();
      }
    });
    $('#mobile-menu').addEventListener('click', () => {
      const open = $('#main-nav').classList.toggle('open');
      $('#mobile-menu').setAttribute('aria-expanded', String(open));
    });
    $('#main-nav').addEventListener('click', event => {
      if (event.target.closest('a')) { $('#main-nav').classList.remove('open'); $('#mobile-menu').setAttribute('aria-expanded', 'false'); }
    });
    $$('.category-card').forEach(card => card.addEventListener('click', () => {
      state.category = card.dataset.category;
      loadProducts();
      $('#shop').scrollIntoView({ behavior: 'smooth' });
    }));
    $('#newsletter-form').addEventListener('submit', async event => {
      event.preventDefault();
      const email = $('#newsletter-email').value.trim();
      if (!/^\S+@\S+\.\S+$/.test(email)) return toast('Enter a valid email address.', 'error');
      const form = event.currentTarget;
      const button = $('button', form);
      button.disabled = true;
      try {
        await api('/api/newsletter', { method: 'POST', body: { email } });
        form.innerHTML = '<div class="form-success">You’re on the list. We’ll only write when we have something worth saying.</div>';
      } catch (error) {
        button.disabled = false;
        toast(error.message, 'error');
      }
    });
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape') { closeDialog(); closeDrawer(); }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); $('#search-input').focus(); $('#shop').scrollIntoView({ behavior: 'smooth' }); }
    });
  }

  async function init() {
    $('#year').textContent = new Date().getFullYear();
    $('#sort-select').value = state.sort;
    updateBagCount();
    renderCart();
    attachEvents();
    await refreshUser();
    await loadProducts();
  }

  init();
})();
