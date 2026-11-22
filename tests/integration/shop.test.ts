/**
 * Anwendungstests gegen eine echte Postgres-Datenbank (im CI: Service-Container).
 * Prüfen die fachliche Korrektheit bei jeder Code-Änderung.
 */
import type { Express } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from '../../src/db/pool.js';
import { appWithDb, resetDb, setupDb, validCustomer, type TestDb } from '../helpers.js';

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

const stockOf = async (id: number) =>
  (await pool.query<{ stock: number }>('SELECT stock FROM products WHERE id = $1', [id])).rows[0]
    ?.stock;

describe('Produktkatalog', () => {
  it('zeigt nur aktive Produkte mit Bestand', async () => {
    const res = await request(app).get('/api/products');
    expect(res.status).toBe(200);
    const names = (res.body.products as { name: string }[]).map((p) => p.name);
    expect(names).toEqual(expect.arrayContaining(['Margherita', 'Salami', 'Cola']));
    expect(names).not.toContain('Alte Pizza');
    expect(names).not.toContain('Ausverkauft');
  });

  it('filtert nach Kategorie und Suchbegriff', async () => {
    const drinks = await request(app).get('/api/products?category=drink');
    expect(drinks.body.products).toHaveLength(1);
    const search = await request(app).get('/api/products?q=marg');
    expect(search.body.products.map((p: { name: string }) => p.name)).toEqual(['Margherita']);
  });

  it('LIKE-Wildcards im Suchbegriff werden wörtlich genommen', async () => {
    const res = await request(app).get('/api/products?q=%25');
    expect(res.status).toBe(200);
    expect(res.body.products).toHaveLength(0);
  });

  it('inaktives Produkt ist auch per ID nicht abrufbar', async () => {
    const res = await request(app).get(`/api/products/${ids.inactive}`);
    expect(res.status).toBe(404);
  });
});

describe('Bestellung', () => {
  it('legt Bestellung an, rechnet mit DB-Preisen und reduziert den Bestand', async () => {
    const res = await request(app)
      .post('/api/orders')
      .send({
        items: [
          { productId: ids.margherita, quantity: 2 },
          { productId: ids.cola, quantity: 3 },
        ],
        customer: validCustomer,
      });
    expect(res.status).toBe(201);
    expect(res.body.order.totalCents).toBe(2 * 890 + 3 * 250);
    expect(res.body.order.status).toBe('received');
    expect(res.body.trackingToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await stockOf(ids.margherita)).toBe(8);
    expect(await stockOf(ids.cola)).toBe(47);
  });

  it('lehnt Überverkauf ab und ändert dann NICHTS (atomar)', async () => {
    const res = await request(app)
      .post('/api/orders')
      .send({
        items: [
          { productId: ids.margherita, quantity: 1 },
          { productId: ids.salami, quantity: 3 }, // nur 2 auf Lager
        ],
        customer: validCustomer,
      });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('OUT_OF_STOCK');
    expect(res.body.error.details.productIds).toEqual([ids.salami]);
    expect(await stockOf(ids.margherita)).toBe(10);
    expect(await stockOf(ids.salami)).toBe(2);
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM orders');
    expect(rows[0]).toEqual({ n: 0 });
  });

  it('lehnt inaktive oder unbekannte Produkte ab', async () => {
    for (const productId of [ids.inactive, 999_999]) {
      const res = await request(app)
        .post('/api/orders')
        .send({ items: [{ productId, quantity: 1 }], customer: validCustomer });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('PRODUCT_UNAVAILABLE');
    }
  });

  it('parallele Bestellungen verkaufen nie mehr als vorhanden', async () => {
    const order = () =>
      request(app)
        .post('/api/orders')
        .send({ items: [{ productId: ids.salami, quantity: 1 }], customer: validCustomer });
    const results = await Promise.all([order(), order(), order(), order()]);
    const created = results.filter((r) => r.status === 201).length;
    expect(created).toBe(2);
    expect(results.filter((r) => r.status === 409)).toHaveLength(2);
    expect(await stockOf(ids.salami)).toBe(0);
  });

  it('Bestellstatus nur mit korrektem Token (IDOR-Schutz)', async () => {
    const created = await request(app)
      .post('/api/orders')
      .send({ items: [{ productId: ids.cola, quantity: 1 }], customer: validCustomer });
    const { order, trackingToken } = created.body as {
      order: { id: string };
      trackingToken: string;
    };

    const ok = await request(app)
      .get(`/api/orders/${order.id}`)
      .set('X-Order-Token', trackingToken);
    expect(ok.status).toBe(200);
    expect(ok.body.order.items[0].name).toBe('Cola');
    // Kundendaten werden über den öffentlichen Endpunkt nicht ausgeliefert
    expect(JSON.stringify(ok.body)).not.toContain(validCustomer.phone);

    const wrongToken = 'A'.repeat(43);
    const denied = await request(app)
      .get(`/api/orders/${order.id}`)
      .set('X-Order-Token', wrongToken);
    expect(denied.status).toBe(404);

    const unknown = await request(app)
      .get('/api/orders/00000000-0000-4000-8000-000000000000')
      .set('X-Order-Token', trackingToken);
    // gleiche Antwort wie falsches Token -> keine Aussage, ob die Bestellung existiert
    expect(unknown.status).toBe(404);
    expect(unknown.body.error.code).toBe(denied.body.error.code);
  });

  it('Tracking-Token wird nur gehasht gespeichert', async () => {
    const created = await request(app)
      .post('/api/orders')
      .send({ items: [{ productId: ids.cola, quantity: 1 }], customer: validCustomer });
    const { rows } = await pool.query<{ tracking_token_hash: string }>(
      'SELECT tracking_token_hash FROM orders',
    );
    expect(rows[0]?.tracking_token_hash).not.toBe(created.body.trackingToken);
    expect(rows[0]?.tracking_token_hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('Health', () => {
  it('readyz ist healthy, wenn DB und Schema passen', async () => {
    const res = await request(app).get('/readyz');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: 'healthy',
      checks: { database: 'up', migrations: 'ok' },
    });
  });
});
