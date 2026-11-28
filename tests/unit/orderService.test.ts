/**
 * Bestelllogik ohne Datenbank: Preise, Bestandsprüfung, Transaktionsverhalten, Zustandsautomat.
 */
import { describe, expect, it } from 'vitest';
import { AppError, ConflictError, NotFoundError, OutOfStockError } from '../../src/errors.js';
import type { OrderStatus } from '../../src/schemas/index.js';
import { sha256Hex } from '../../src/services/crypto.js';
import { ORDER_TRANSITIONS, OrderService } from '../../src/services/orderService.js';
import { fakePool } from './fakeDb.js';

const customer = {
  name: 'Max Mustermann',
  street: 'Hauptstraße 1',
  zip: '12345',
  city: 'Berlin',
  phone: '+49 30 123456',
};

const catalog = [
  { id: 1, name: 'Margherita', price_cents: 890, stock: 10, active: true },
  { id: 2, name: 'Salami', price_cents: 990, stock: 2, active: true },
  { id: 3, name: 'Alt', price_cents: 700, stock: 5, active: false },
];

function dbWithCatalog() {
  return fakePool((sql, params) => {
    if (sql.startsWith('SELECT id, name, price_cents')) {
      const ids = params[0] as number[];
      return { rows: catalog.filter((p) => ids.includes(p.id)) };
    }
    if (sql.startsWith('INSERT INTO orders')) {
      return { rows: [{ id: 'order-1', status: 'received', created_at: new Date(0) }] };
    }
    return undefined;
  });
}

describe('OrderService.create', () => {
  it('rechnet ausschließlich mit Preisen aus der DB und reduziert den Bestand', async () => {
    const db = dbWithCatalog();
    const { order, trackingToken } = await new OrderService(db.pool).create({
      items: [
        { productId: 1, quantity: 2 },
        { productId: 2, quantity: 1 },
      ],
      customer,
    });
    expect(order.totalCents).toBe(2 * 890 + 990);
    expect(order.items.map((i) => i.unitPriceCents)).toEqual([890, 990]);
    const stockUpdates = db.find(/^UPDATE products SET stock = stock - \$2/);
    expect(stockUpdates.map((c) => c.params)).toEqual([
      [1, 2],
      [2, 1],
    ]);
    expect(db.sqls().at(0)).toBe('BEGIN');
    expect(db.sqls().at(-1)).toBe('COMMIT');
    expect(trackingToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('sperrt die Produktzeilen (FOR UPDATE) in fester Reihenfolge gegen Deadlocks', async () => {
    const db = dbWithCatalog();
    await new OrderService(db.pool).create({ items: [{ productId: 2, quantity: 1 }], customer });
    expect(
      db.find(/FROM products WHERE id = ANY\(\$1::int\[\]\) ORDER BY id FOR UPDATE$/),
    ).toHaveLength(1);
  });

  it('speichert nur den Hash des Tracking-Tokens', async () => {
    const db = dbWithCatalog();
    const { trackingToken } = await new OrderService(db.pool).create({
      items: [{ productId: 1, quantity: 1 }],
      customer,
    });
    const insert = db.find(/^INSERT INTO orders/)[0];
    expect(insert?.params[0]).toBe(sha256Hex(trackingToken));
    expect(insert?.params).not.toContain(trackingToken);
  });

  it('Überverkauf: OutOfStockError, ROLLBACK, kein INSERT', async () => {
    const db = dbWithCatalog();
    const attempt = new OrderService(db.pool).create({
      items: [
        { productId: 1, quantity: 1 },
        { productId: 2, quantity: 3 },
      ],
      customer,
    });
    await expect(attempt).rejects.toBeInstanceOf(OutOfStockError);
    await expect(attempt).rejects.toMatchObject({ details: { productIds: [2] } });
    expect(db.sqls()).toContain('ROLLBACK');
    expect(db.sqls()).not.toContain('COMMIT');
    expect(db.find(/^INSERT/)).toHaveLength(0);
    expect(db.client.release).toHaveBeenCalledOnce();
  });

  it('inaktive und unbekannte Produkte: 400 PRODUCT_UNAVAILABLE', async () => {
    const db = dbWithCatalog();
    const attempt = new OrderService(db.pool).create({
      items: [
        { productId: 3, quantity: 1 },
        { productId: 99, quantity: 1 },
      ],
      customer,
    });
    await expect(attempt).rejects.toBeInstanceOf(AppError);
    await expect(attempt).rejects.toMatchObject({
      status: 400,
      code: 'PRODUCT_UNAVAILABLE',
      details: { productIds: [3, 99] },
    });
    expect(db.sqls()).toContain('ROLLBACK');
  });

  it('DB-Fehler mitten in der Transaktion -> ROLLBACK und Verbindung wird freigegeben', async () => {
    const db = fakePool((sql, params) => {
      if (sql.startsWith('SELECT id, name, price_cents')) {
        return { rows: catalog.filter((p) => (params[0] as number[]).includes(p.id)) };
      }
      if (sql.startsWith('INSERT INTO orders')) return new Error('connection lost');
      return undefined;
    });
    await expect(
      new OrderService(db.pool).create({ items: [{ productId: 1, quantity: 1 }], customer }),
    ).rejects.toThrow('connection lost');
    expect(db.sqls()).toContain('ROLLBACK');
    expect(db.client.release).toHaveBeenCalledOnce();
  });
});

describe('OrderService.getForCustomer (IDOR-Schutz)', () => {
  const token = 'A'.repeat(43);
  const stored = {
    id: 'o1',
    status: 'baking',
    total_cents: 890,
    created_at: new Date(0),
    tracking_token_hash: sha256Hex(token),
  };

  it('liefert die Bestellung bei passendem Token', async () => {
    const db = fakePool((sql) =>
      sql.includes('FROM orders WHERE id') ? { rows: [stored] } : undefined,
    );
    const order = await new OrderService(db.pool).getForCustomer('o1', token);
    expect(order).toMatchObject({ id: 'o1', status: 'baking', totalCents: 890 });
  });

  it('falsches Token und unbekannte ID liefern denselben NotFoundError', async () => {
    const withOrder = fakePool((sql) =>
      sql.includes('FROM orders WHERE id') ? { rows: [stored] } : undefined,
    );
    const empty = fakePool();
    const wrong = new OrderService(withOrder.pool).getForCustomer('o1', 'B'.repeat(43));
    const missing = new OrderService(empty.pool).getForCustomer('o1', token);
    await expect(wrong).rejects.toBeInstanceOf(NotFoundError);
    await expect(missing).rejects.toBeInstanceOf(NotFoundError);
    // bei falschem Token werden keine Positionen nachgeladen
    expect(withOrder.find(/FROM order_items/)).toHaveLength(0);
  });
});

describe('Zustandsautomat Bestellstatus', () => {
  const all = Object.keys(ORDER_TRANSITIONS) as OrderStatus[];

  it('Endzustände haben keine Übergänge', () => {
    expect(ORDER_TRANSITIONS.delivered).toEqual([]);
    expect(ORDER_TRANSITIONS.cancelled).toEqual([]);
  });

  it('kein Status kann in sich selbst oder zurück nach "received" wechseln', () => {
    for (const s of all) {
      expect(ORDER_TRANSITIONS[s]).not.toContain(s);
      expect(ORDER_TRANSITIONS[s]).not.toContain('received');
    }
  });

  it('jeder Status ist von "received" aus erreichbar', () => {
    const seen = new Set<OrderStatus>(['received']);
    const queue: OrderStatus[] = ['received'];
    while (queue.length) {
      for (const next of ORDER_TRANSITIONS[queue.shift() as OrderStatus]) {
        if (!seen.has(next)) {
          seen.add(next);
          queue.push(next);
        }
      }
    }
    expect([...seen].sort()).toEqual([...all].sort());
  });

  const statusDb = (current: OrderStatus | undefined) =>
    fakePool((sql) =>
      sql.startsWith('SELECT status FROM orders')
        ? { rows: current ? [{ status: current }] : [] }
        : undefined,
    );

  it('ungültiger Übergang -> ConflictError, kein UPDATE', async () => {
    const db = statusDb('delivering');
    await expect(new OrderService(db.pool).changeStatus('o1', 'cancelled')).rejects.toBeInstanceOf(
      ConflictError,
    );
    expect(db.find(/^UPDATE/)).toHaveLength(0);
    expect(db.sqls()).toContain('ROLLBACK');
  });

  it('Stornierung bucht den Bestand zurück, normaler Wechsel nicht', async () => {
    const cancel = statusDb('received');
    await new OrderService(cancel.pool).changeStatus('o1', 'cancelled');
    expect(cancel.find(/^UPDATE products p SET stock = LEAST/)).toHaveLength(1);

    const bake = statusDb('received');
    await new OrderService(bake.pool).changeStatus('o1', 'baking');
    expect(bake.find(/^UPDATE products/)).toHaveLength(0);
    expect(bake.find(/^UPDATE orders SET status/)[0]?.params).toEqual(['o1', 'baking']);
  });

  it('unbekannte Bestellung -> NotFoundError', async () => {
    await expect(
      new OrderService(statusDb(undefined).pool).changeStatus('x', 'baking'),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});
