/** Admin-Funktionen: Authentifizierung, Sortiment, Bestand, Bestellstatus. */
import type { Express } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from '../../src/db/pool.js';
import {
  ADMIN_PASSWORD,
  appWithDb,
  resetDb,
  setupDb,
  validCustomer,
  type TestDb,
} from '../helpers.js';

let pool: Pool;
let app: Express;
let ids: TestDb['products'];

beforeAll(async () => {
  pool = await setupDb();
});
afterAll(async () => {
  await pool.end();
});
beforeEach(async () => {
  ids = await resetDb(pool);
  app = await appWithDb(pool);
});

async function login(): Promise<string> {
  const res = await request(app)
    .post('/api/admin/login')
    .send({ username: 'admin', password: ADMIN_PASSWORD });
  expect(res.status).toBe(200);
  const raw = res.headers['set-cookie'] as unknown as string[];
  const cookie = raw.find((c) => c.startsWith('pizza_admin='));
  if (!cookie) throw new Error('kein Session-Cookie');
  return cookie.split(';')[0] as string;
}

describe('Admin-Authentifizierung', () => {
  it('Session-Cookie ist HttpOnly, SameSite=Strict und auf /api/admin beschränkt', async () => {
    const res = await request(app)
      .post('/api/admin/login')
      .send({ username: 'admin', password: ADMIN_PASSWORD });
    const cookie = (res.headers['set-cookie'] as unknown as string[])[0] ?? '';
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Strict/i);
    expect(cookie).toMatch(/Path=\/api\/admin/);
  });

  it('falsches Passwort und unbekannter Benutzer liefern dieselbe Antwort', async () => {
    const wrongPw = await request(app)
      .post('/api/admin/login')
      .send({ username: 'admin', password: 'falsch' });
    const unknown = await request(app)
      .post('/api/admin/login')
      .send({ username: 'nobody', password: 'falsch' });
    expect(wrongPw.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrongPw.body.error.message).toBe(unknown.body.error.message);
  });

  it('Session-Token wird nur gehasht gespeichert', async () => {
    const cookie = await login();
    const token = cookie.split('=')[1];
    const { rows } = await pool.query<{ token_hash: string }>(
      'SELECT token_hash FROM admin_sessions',
    );
    expect(rows[0]?.token_hash).not.toBe(token);
  });

  it('Logout invalidiert die Session serverseitig', async () => {
    const cookie = await login();
    expect((await request(app).get('/api/admin/me').set('Cookie', cookie)).status).toBe(200);
    await request(app)
      .post('/api/admin/logout')
      .set('Cookie', cookie)
      .set('Content-Type', 'application/json')
      .send('{}');
    expect((await request(app).get('/api/admin/me').set('Cookie', cookie)).status).toBe(401);
  });

  it('abgelaufene Session wird abgelehnt', async () => {
    const cookie = await login();
    await pool.query("UPDATE admin_sessions SET expires_at = now() - interval '1 minute'");
    expect((await request(app).get('/api/admin/me').set('Cookie', cookie)).status).toBe(401);
  });

  it('Rate-Limit bremst Brute-Force auf den Login', async () => {
    const limited = await appWithDb(pool, { LOGIN_RATE_LIMIT: '3' });
    const attempt = () =>
      request(limited).post('/api/admin/login').send({ username: 'admin', password: 'falsch' });
    for (let i = 0; i < 3; i++) expect((await attempt()).status).toBe(401);
    expect((await attempt()).status).toBe(429);
  });
});

describe('Sortiment & Bestand', () => {
  it('Produkt aus dem Sortiment nehmen -> verschwindet im Shop', async () => {
    const cookie = await login();
    const res = await request(app)
      .patch(`/api/admin/products/${ids.margherita}`)
      .set('Cookie', cookie)
      .send({ active: false });
    expect(res.status).toBe(200);
    expect(res.body.product.active).toBe(false);
    const shop = await request(app).get('/api/products');
    expect(shop.body.products.map((p: { name: string }) => p.name)).not.toContain('Margherita');
  });

  it('Bestand setzen und relativ anpassen', async () => {
    const cookie = await login();
    const set = await request(app)
      .patch(`/api/admin/products/${ids.salami}/stock`)
      .set('Cookie', cookie)
      .send({ mode: 'set', value: 20 });
    expect(set.body.stock).toBe(20);
    const adj = await request(app)
      .patch(`/api/admin/products/${ids.salami}/stock`)
      .set('Cookie', cookie)
      .send({ mode: 'adjust', value: -5 });
    expect(adj.body.stock).toBe(15);
  });

  it('Bestand kann nicht negativ werden', async () => {
    const cookie = await login();
    const res = await request(app)
      .patch(`/api/admin/products/${ids.salami}/stock`)
      .set('Cookie', cookie)
      .send({ mode: 'adjust', value: -3 });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('STOCK_OUT_OF_RANGE');
  });

  it('neues Produkt anlegen, doppelter Name -> 409', async () => {
    const cookie = await login();
    const body = { name: 'Hawaii', category: 'pizza', priceCents: 1000, stock: 5 };
    const ok = await request(app).post('/api/admin/products').set('Cookie', cookie).send(body);
    expect(ok.status).toBe(201);
    const dup = await request(app).post('/api/admin/products').set('Cookie', cookie).send(body);
    expect(dup.status).toBe(409);
  });

  it('Update ohne Felder oder mit unbekanntem Feld -> 400', async () => {
    const cookie = await login();
    const empty = await request(app)
      .patch(`/api/admin/products/${ids.cola}`)
      .set('Cookie', cookie)
      .send({});
    expect(empty.status).toBe(400);
    const extra = await request(app)
      .patch(`/api/admin/products/${ids.cola}`)
      .set('Cookie', cookie)
      .send({ stock: 999 }); // Bestand nur über den Stock-Endpunkt
    expect(extra.status).toBe(400);
  });
});

describe('Bestellungen verwalten', () => {
  async function placeOrder(quantity = 2) {
    const res = await request(app)
      .post('/api/orders')
      .send({ items: [{ productId: ids.margherita, quantity }], customer: validCustomer });
    return res.body.order.id as string;
  }

  it('listet Bestellungen inkl. Kundendaten nur für Admins', async () => {
    await placeOrder();
    const cookie = await login();
    const res = await request(app).get('/api/admin/orders').set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.body.orders[0].customerName).toBe(validCustomer.name);
  });

  it('erlaubt nur gültige Statusübergänge', async () => {
    const id = await placeOrder();
    const cookie = await login();
    const patch = (status: string) =>
      request(app).patch(`/api/admin/orders/${id}/status`).set('Cookie', cookie).send({ status });
    expect((await patch('delivered')).status).toBe(409); // received -> delivered übersprungen
    expect((await patch('baking')).status).toBe(200);
    expect((await patch('delivering')).status).toBe(200);
    expect((await patch('cancelled')).status).toBe(409); // unterwegs -> nicht mehr stornierbar
    expect((await patch('delivered')).status).toBe(200);
  });

  it('Stornierung bucht den Bestand zurück', async () => {
    const id = await placeOrder(3);
    const cookie = await login();
    const before = await pool.query<{ stock: number }>('SELECT stock FROM products WHERE id = $1', [
      ids.margherita,
    ]);
    expect(before.rows[0]?.stock).toBe(7);
    const res = await request(app)
      .patch(`/api/admin/orders/${id}/status`)
      .set('Cookie', cookie)
      .send({ status: 'cancelled' });
    expect(res.status).toBe(200);
    const after = await pool.query<{ stock: number }>('SELECT stock FROM products WHERE id = $1', [
      ids.margherita,
    ]);
    expect(after.rows[0]?.stock).toBe(10);
  });
});
