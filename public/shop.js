// Shop-Frontend. Sicherheitsregel: Daten werden NIE als HTML eingefügt (nur textContent/createElement),
// damit z.B. ein manipulierter Produktname kein Script ausführen kann (XSS). ESLint erzwingt das.
'use strict';

const CATEGORY_LABEL = { pizza: 'Pizza', drink: 'Getränk', dessert: 'Dessert' };
const STATUS_LABEL = {
  received: 'Eingegangen',
  baking: 'Im Ofen',
  delivering: 'Unterwegs',
  delivered: 'Geliefert',
  cancelled: 'Storniert',
};
const ICON = { pizza: '🍕', drink: '🥤', dessert: '🍰' };

const state = { products: [], cart: new Map(), category: '', q: '' };
const euro = (cents) =>
  (cents / 100).toLocaleString('de-DE', { style: 'currency', currency: 'EUR' });

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'class') node.className = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value);
  }
  for (const child of children)
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  return node;
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  const body = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error(body?.error?.message || `Fehler ${res.status}`);
    err.code = body?.error?.code;
    err.details = body?.error?.details;
    err.requestId = body?.error?.requestId;
    throw err;
  }
  return body;
}

// ---------- Produkte ----------
async function loadProducts() {
  const params = new URLSearchParams();
  if (state.category) params.set('category', state.category);
  if (state.q) params.set('q', state.q);
  const grid = document.getElementById('products');
  try {
    const { products } = await api(`/api/products?${params}`);
    state.products = products;
    renderProducts();
  } catch (err) {
    grid.replaceChildren(
      el('p', { class: 'msg error' }, `Speisekarte konnte nicht geladen werden. (${err.message})`),
    );
  }
}

function renderProducts() {
  const grid = document.getElementById('products');
  if (!state.products.length) {
    grid.replaceChildren(el('p', { class: 'muted' }, 'Keine Produkte gefunden.'));
    return;
  }
  grid.replaceChildren(
    ...state.products.map((p) =>
      el(
        'article',
        { class: 'card' },
        el('div', { class: 'card-icon', 'aria-hidden': 'true' }, ICON[p.category] || '🍽️'),
        el('h3', {}, p.name),
        el('p', { class: 'muted small' }, p.description),
        el('p', { class: 'tag' }, CATEGORY_LABEL[p.category] || p.category),
        el(
          'div',
          { class: 'card-foot' },
          el('strong', {}, euro(p.priceCents)),
          el('button', { class: 'primary small', onclick: () => addToCart(p) }, 'In den Warenkorb'),
        ),
        p.stock <= 5 ? el('p', { class: 'low-stock' }, `Nur noch ${p.stock} verfügbar`) : '',
      ),
    ),
  );
}

// ---------- Warenkorb ----------
function addToCart(product) {
  const entry = state.cart.get(product.id) || { product, quantity: 0 };
  if (entry.quantity >= Math.min(20, product.stock)) return;
  entry.quantity += 1;
  state.cart.set(product.id, entry);
  renderCart();
}

function changeQty(id, delta) {
  const entry = state.cart.get(id);
  if (!entry) return;
  entry.quantity = Math.min(entry.quantity + delta, 20, entry.product.stock);
  if (entry.quantity <= 0) state.cart.delete(id);
  renderCart();
}

function renderCart() {
  const list = document.getElementById('cart-items');
  const entries = [...state.cart.values()];
  list.replaceChildren(
    ...(entries.length
      ? entries.map(({ product, quantity }) =>
          el(
            'li',
            {},
            el('span', { class: 'grow' }, product.name),
            el(
              'button',
              { class: 'qty', 'aria-label': 'weniger', onclick: () => changeQty(product.id, -1) },
              '−',
            ),
            el('span', { class: 'count' }, quantity),
            el(
              'button',
              { class: 'qty', 'aria-label': 'mehr', onclick: () => changeQty(product.id, 1) },
              '+',
            ),
            el('span', { class: 'price' }, euro(product.priceCents * quantity)),
          ),
        )
      : [el('li', { class: 'muted' }, 'Noch leer.')]),
  );
  // Anzeige-Summe – verbindlich ist der vom Server berechnete Betrag.
  const total = entries.reduce((s, e) => s + e.product.priceCents * e.quantity, 0);
  document.getElementById('cart-total').textContent = euro(total);
  document.getElementById('order-btn').disabled = entries.length === 0;
}

// ---------- Checkout ----------
async function submitOrder(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const msg = document.getElementById('checkout-msg');
  if (!form.checkValidity()) {
    form.reportValidity();
    return;
  }
  const data = new FormData(form);
  const payload = {
    items: [...state.cart.values()].map((e) => ({ productId: e.product.id, quantity: e.quantity })),
    customer: Object.fromEntries(
      ['name', 'street', 'zip', 'city', 'phone'].map((k) => [k, String(data.get(k) || '').trim()]),
    ),
  };
  msg.className = 'msg';
  msg.textContent = 'Bestellung wird gesendet …';
  try {
    const { order, trackingToken } = await api('/api/orders', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    state.cart.clear();
    renderCart();
    form.reset();
    msg.className = 'msg success';
    msg.replaceChildren(
      el('strong', {}, `Danke! Gesamt: ${euro(order.totalCents)}`),
      el('br'),
      'Bestellnummer: ',
      el('code', {}, order.id),
      el('br'),
      'Code: ',
      el('code', {}, trackingToken),
      el('br'),
      el('small', {}, 'Bitte notieren – der Code wird nur einmal angezeigt.'),
    );
    const trackForm = document.getElementById('track-form');
    trackForm.orderId.value = order.id;
    trackForm.token.value = trackingToken;
    loadProducts();
  } catch (err) {
    msg.className = 'msg error';
    msg.textContent =
      err.code === 'OUT_OF_STOCK'
        ? 'Leider ist ein Produkt nicht mehr ausreichend vorrätig. Bitte Warenkorb anpassen.'
        : err.code === 'VALIDATION_FAILED'
          ? 'Bitte Eingaben prüfen: ' + (err.details?.issues || []).map((i) => i.path).join(', ')
          : `${err.message}${err.requestId ? ` (Ref: ${err.requestId})` : ''}`;
    loadProducts();
  }
}

// ---------- Tracking ----------
async function trackOrder(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const out = document.getElementById('track-result');
  const id = form.orderId.value.trim();
  const token = form.token.value.trim();
  try {
    // Token im Header, nicht in der URL (landet so nicht in History/Logs).
    const { order } = await api(`/api/orders/${encodeURIComponent(id)}`, {
      headers: { 'X-Order-Token': token },
    });
    out.replaceChildren(
      el(
        'p',
        {},
        'Status: ',
        el(
          'strong',
          { class: `status status-${order.status}` },
          STATUS_LABEL[order.status] || order.status,
        ),
      ),
      el('ul', {}, ...order.items.map((i) => el('li', {}, `${i.quantity}× ${i.name}`))),
      el('p', {}, `Summe: ${euro(order.totalCents)}`),
    );
  } catch (err) {
    out.replaceChildren(
      el(
        'p',
        { class: 'msg error' },
        err.code === 'NOT_FOUND' ? 'Keine Bestellung mit diesen Daten gefunden.' : err.message,
      ),
    );
  }
}

// ---------- Init ----------
let searchTimer;
document.getElementById('search').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.q = e.target.value.trim();
    loadProducts();
  }, 250);
});
for (const chip of document.querySelectorAll('.chip')) {
  chip.addEventListener('click', () => {
    document.querySelectorAll('.chip').forEach((c) => c.classList.toggle('active', c === chip));
    state.category = chip.dataset.category;
    loadProducts();
  });
}
document.getElementById('checkout').addEventListener('submit', submitOrder);
document.getElementById('track-form').addEventListener('submit', trackOrder);
renderCart();
loadProducts();
