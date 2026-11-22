// Admin-Frontend. Das Session-Cookie ist HttpOnly -> dieses Script sieht es nie.
// Alle Daten werden per textContent/createElement eingefügt (kein innerHTML, siehe ESLint-Regel).
'use strict';

const STATUS_LABEL = {
  received: 'Eingegangen',
  baking: 'Im Ofen',
  delivering: 'Unterwegs',
  delivered: 'Geliefert',
  cancelled: 'Storniert',
};
// Spiegel des Zustandsautomaten im Backend (nur für die Anzeige; erzwungen wird serverseitig).
const NEXT = {
  received: ['baking', 'cancelled'],
  baking: ['delivering', 'cancelled'],
  delivering: ['delivered'],
  delivered: [],
  cancelled: [],
};
const euro = (cents) =>
  (cents / 100).toLocaleString('de-DE', { style: 'currency', currency: 'EUR' });
const $ = (id) => document.getElementById(id);

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'class') node.className = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else if (key === 'checked' || key === 'disabled') node[key] = Boolean(value);
    else node.setAttribute(key, value);
  }
  for (const child of children)
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  return node;
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    credentials: 'same-origin',
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  const body = res.status === 204 ? null : await res.json().catch(() => null);
  if (res.status === 401 && !path.endsWith('/login') && !path.endsWith('/me')) {
    showLogin('Sitzung abgelaufen – bitte erneut anmelden.');
  }
  if (!res.ok) {
    const err = new Error(body?.error?.message || `Fehler ${res.status}`);
    err.code = body?.error?.code;
    err.requestId = body?.error?.requestId;
    throw err;
  }
  return body;
}

function flash(text, kind = 'success') {
  const msg = $('admin-msg');
  msg.className = `msg ${kind}`;
  msg.textContent = text;
}
const fail = (err) =>
  flash(`${err.message}${err.requestId ? ` (Ref: ${err.requestId})` : ''}`, 'error');

// ---------- Login ----------
function showLogin(message = '') {
  $('login-view').hidden = false;
  $('admin-view').hidden = true;
  $('logout').hidden = true;
  $('who').textContent = '';
  $('login-msg').textContent = message;
}

async function showAdmin(username) {
  $('login-view').hidden = true;
  $('admin-view').hidden = false;
  $('logout').hidden = false;
  $('who').textContent = `angemeldet als ${username}`;
  await loadProducts();
}

$('login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const msg = $('login-msg');
  try {
    const { admin } = await api('/api/admin/login', {
      method: 'POST',
      body: JSON.stringify({ username: form.username.value, password: form.password.value }),
    });
    form.reset();
    await showAdmin(admin.username);
  } catch (err) {
    msg.className = 'msg error';
    msg.textContent =
      err.code === 'TOO_MANY_REQUESTS' ? 'Zu viele Versuche. Bitte später erneut.' : err.message;
  }
});

$('logout').addEventListener('click', async () => {
  await api('/api/admin/logout', { method: 'POST', body: '{}' }).catch(() => undefined);
  showLogin('Abgemeldet.');
});

// ---------- Produkte ----------
async function loadProducts() {
  try {
    const { products } = await api('/api/admin/products');
    $('product-rows').replaceChildren(...products.map(productRow));
  } catch (err) {
    fail(err);
  }
}

function productRow(p) {
  const stockInput = el('input', {
    type: 'number',
    min: '0',
    max: '100000',
    step: '1',
    value: String(p.stock),
    class: 'num',
    'aria-label': `Bestand ${p.name}`,
  });
  const deltaInput = el('input', {
    type: 'number',
    min: '-100000',
    max: '100000',
    step: '1',
    value: '10',
    class: 'num',
    'aria-label': `Zugang ${p.name}`,
  });
  return el(
    'tr',
    { class: p.active ? '' : 'inactive' },
    el('td', {}, p.id),
    el('td', {}, p.name),
    el('td', {}, p.category),
    el('td', {}, euro(p.priceCents)),
    el('td', { class: p.stock === 0 ? 'warn' : '' }, p.stock),
    el(
      'td',
      {},
      el(
        'label',
        { class: 'switch' },
        el('input', {
          type: 'checkbox',
          checked: p.active,
          onchange: (e) => setActive(p, e.target.checked),
        }),
        p.active ? ' aktiv' : ' entfernt',
      ),
    ),
    el(
      'td',
      { class: 'stock-actions' },
      stockInput,
      el(
        'button',
        {
          class: 'small',
          onclick: () => changeStock(p, { mode: 'set', value: Number(stockInput.value) }),
        },
        'Setzen',
      ),
      deltaInput,
      el(
        'button',
        {
          class: 'small',
          onclick: () => changeStock(p, { mode: 'adjust', value: Number(deltaInput.value) }),
        },
        '± Anpassen',
      ),
    ),
  );
}

async function setActive(product, active) {
  try {
    await api(`/api/admin/products/${product.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ active }),
    });
    flash(`„${product.name}“ ${active ? 'wieder im Sortiment' : 'aus dem Sortiment genommen'}.`);
  } catch (err) {
    fail(err);
  }
  loadProducts();
}

async function changeStock(product, body) {
  if (!Number.isInteger(body.value)) {
    flash('Bitte eine ganze Zahl eingeben.', 'error');
    return;
  }
  try {
    const res = await api(`/api/admin/products/${product.id}/stock`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    });
    flash(`Bestand „${product.name}“: ${res.stock}`);
  } catch (err) {
    fail(err);
  }
  loadProducts();
}

$('new-product').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  if (!form.checkValidity()) {
    form.reportValidity();
    return;
  }
  const body = {
    name: form.name.value.trim(),
    description: form.description.value.trim(),
    category: form.category.value,
    priceCents: Math.round(Number(form.price.value) * 100),
    stock: Number(form.stock.value),
  };
  try {
    await api('/api/admin/products', { method: 'POST', body: JSON.stringify(body) });
    flash(`„${body.name}“ angelegt.`);
    form.reset();
    loadProducts();
  } catch (err) {
    fail(err);
  }
});

// ---------- Bestellungen ----------
async function loadOrders() {
  const status = $('order-filter').value;
  try {
    const { orders } = await api(
      `/api/admin/orders${status ? `?status=${encodeURIComponent(status)}` : ''}`,
    );
    $('order-rows').replaceChildren(
      ...(orders.length
        ? orders.map(orderRow)
        : [el('tr', {}, el('td', { colspan: '6', class: 'muted' }, 'Keine Bestellungen.'))]),
    );
  } catch (err) {
    fail(err);
  }
}

function orderRow(o) {
  const select = el(
    'select',
    { onchange: (e) => changeStatus(o, e.target.value), disabled: NEXT[o.status].length === 0 },
    el('option', { value: o.status }, STATUS_LABEL[o.status]),
    ...NEXT[o.status].map((s) => el('option', { value: s }, `→ ${STATUS_LABEL[s]}`)),
  );
  return el(
    'tr',
    {},
    el('td', {}, new Date(o.createdAt).toLocaleString('de-DE')),
    el('td', {}, o.customerName, el('br'), el('small', { class: 'muted' }, o.phone)),
    el('td', {}, `${o.street}, ${o.zip} ${o.city}`),
    el('td', {}, o.items.map((i) => `${i.quantity}× ${i.name}`).join(', ')),
    el('td', {}, euro(o.totalCents)),
    el('td', {}, select),
  );
}

async function changeStatus(order, status) {
  if (status === order.status) return;
  if (
    status === 'cancelled' &&
    !confirm('Bestellung stornieren? Der Bestand wird zurückgebucht.')
  ) {
    loadOrders();
    return;
  }
  try {
    await api(`/api/admin/orders/${order.id}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ status }),
    });
    flash(`Status: ${STATUS_LABEL[status]}`);
  } catch (err) {
    fail(err);
  }
  loadOrders();
}
$('order-filter').addEventListener('change', loadOrders);

// ---------- Tabs & Start ----------
for (const tab of document.querySelectorAll('.tab')) {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === tab));
    $('tab-products').hidden = tab.dataset.tab !== 'products';
    $('tab-orders').hidden = tab.dataset.tab !== 'orders';
    $('admin-msg').textContent = '';
    if (tab.dataset.tab === 'orders') loadOrders();
    else loadProducts();
  });
}

api('/api/admin/me')
  .then(({ admin }) => showAdmin(admin.username))
  .catch(() => showLogin());
