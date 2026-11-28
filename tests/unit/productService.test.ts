/**
 * Produktlogik ohne Datenbank: SQL-Aufbau (Injection-Schutz), LIKE-Escaping, Bestandsgrenzen.
 */
import { describe, expect, it } from 'vitest';
import { ConflictError, NotFoundError } from '../../src/errors.js';
import { ProductService } from '../../src/services/productService.js';
import { fakePool, pgError } from './fakeDb.js';

const margherita = {
  id: 1,
  name: 'Margherita',
  description: '',
  category: 'pizza',
  priceCents: 890,
  stock: 10,
  active: true,
};

describe('ProductService.listPublic', () => {
  it('übergibt Filter nur als Parameter, nie im SQL-Text', async () => {
    const db = fakePool();
    await new ProductService(db.pool).listPublic({ category: 'pizza', q: "x' OR 1=1 --" });
    const call = db.calls[0];
    expect(call?.sql).not.toContain('OR 1=1');
    expect(call?.params).toEqual(['pizza', "x' OR 1=1 --"]);
  });

  it('escaped LIKE-Wildcards (%, _, \\), damit sie wörtlich gesucht werden', async () => {
    const db = fakePool();
    await new ProductService(db.pool).listPublic({ q: '50%_rabatt\\' });
    expect(db.calls[0]?.params[1]).toBe('50\\%\\_rabatt\\\\');
  });

  it('ohne Filter werden NULL-Parameter gesendet', async () => {
    const db = fakePool();
    await new ProductService(db.pool).listPublic({});
    expect(db.calls[0]?.params).toEqual([null, null]);
  });

  it('öffentliche Liste filtert inaktive und ausverkaufte Produkte', async () => {
    const db = fakePool();
    await new ProductService(db.pool).listPublic({});
    expect(db.calls[0]?.sql).toMatch(/WHERE active AND stock > 0/);
  });
});

describe('ProductService.update (dynamisches SQL)', () => {
  const db = () =>
    fakePool((sql) =>
      sql.startsWith('SELECT') || sql.startsWith('UPDATE') ? { rows: [margherita] } : undefined,
    );

  it('setzt nur übergebene Felder; Spaltennamen kommen aus fester Zuordnung', async () => {
    const d = db();
    await new ProductService(d.pool).update(1, { priceCents: 990, active: false });
    const update = d.find(/^UPDATE products SET/)[0];
    expect(update?.sql).toContain('price_cents = $1');
    expect(update?.sql).toContain('active = $2');
    expect(update?.sql).toContain('WHERE id = $3');
    expect(update?.sql).not.toMatch(/name =|description =|category =/);
    expect(update?.params).toEqual([990, false, 1]);
  });

  it('unerwartete Schlüssel im Eingabeobjekt landen nie im SQL', async () => {
    const d = db();
    const malicious = { name: 'Neu', 'stock = 0; DROP TABLE products; --': 1 } as unknown as {
      name: string;
    };
    await new ProductService(d.pool).update(1, malicious);
    const update = d.find(/^UPDATE products SET/)[0];
    expect(update?.sql).not.toContain('DROP');
    expect(update?.params).toEqual(['Neu', 1]);
  });

  it('liefert vorher/nachher für das Audit-Log', async () => {
    const result = await new ProductService(db().pool).update(1, { name: 'Neu' });
    expect(result.before).toEqual(margherita);
    expect(result.after).toEqual(margherita);
  });

  it('unbekanntes Produkt -> NotFoundError, kein UPDATE', async () => {
    const d = fakePool();
    await expect(new ProductService(d.pool).update(7, { name: 'X1' })).rejects.toBeInstanceOf(
      NotFoundError,
    );
    expect(d.find(/^UPDATE/)).toHaveLength(0);
  });

  it('doppelter Name (unique_violation) -> ConflictError DUPLICATE_NAME', async () => {
    const d = fakePool((sql) => {
      if (sql.startsWith('SELECT')) return { rows: [margherita] };
      if (sql.startsWith('UPDATE')) return pgError('23505');
      return undefined;
    });
    await expect(new ProductService(d.pool).update(1, { name: 'Salami' })).rejects.toMatchObject({
      code: 'DUPLICATE_NAME',
      status: 409,
    });
  });
});

describe('ProductService.create', () => {
  it('doppelter Name -> 409, andere DB-Fehler werden durchgereicht', async () => {
    const input = {
      name: 'X1',
      description: '',
      category: 'pizza' as const,
      priceCents: 100,
      stock: 0,
      active: true,
    };
    const dup = fakePool(() => pgError('23505'));
    await expect(new ProductService(dup.pool).create(input)).rejects.toBeInstanceOf(ConflictError);
    const other = fakePool(() => pgError('08006'));
    await expect(new ProductService(other.pool).create(input)).rejects.not.toBeInstanceOf(
      ConflictError,
    );
  });
});

describe('ProductService.changeStock', () => {
  const stockDb = (stock: number | undefined) =>
    fakePool((sql) =>
      sql.startsWith('SELECT stock') ? { rows: stock === undefined ? [] : [{ stock }] } : undefined,
    );

  it.each([
    [{ mode: 'set' as const, value: 25 }, 10, 25],
    [{ mode: 'adjust' as const, value: 5 }, 10, 15],
    [{ mode: 'adjust' as const, value: -10 }, 10, 0],
  ])('%o bei Bestand %i -> %i', async (input, current, expected) => {
    const db = stockDb(current);
    const result = await new ProductService(db.pool).changeStock(1, input);
    expect(result).toEqual({ before: current, after: expected });
    expect(db.find(/^UPDATE products SET stock = \$2/)[0]?.params).toEqual([1, expected]);
    expect(db.sqls()).toContain('COMMIT');
  });

  it('sperrt die Zeile vor dem Lesen (FOR UPDATE) -> kein Lost Update', async () => {
    const db = stockDb(10);
    await new ProductService(db.pool).changeStock(1, { mode: 'adjust', value: 1 });
    expect(db.sqls()[1]).toBe('SELECT stock FROM products WHERE id = $1 FOR UPDATE');
  });

  it.each([
    [{ mode: 'adjust' as const, value: -11 }, 10],
    [{ mode: 'adjust' as const, value: 1 }, 100_000],
  ])('%o bei Bestand %i -> STOCK_OUT_OF_RANGE, ROLLBACK', async (input, current) => {
    const db = stockDb(current);
    await expect(new ProductService(db.pool).changeStock(1, input)).rejects.toMatchObject({
      code: 'STOCK_OUT_OF_RANGE',
    });
    expect(db.find(/^UPDATE/)).toHaveLength(0);
    expect(db.sqls()).toContain('ROLLBACK');
  });

  it('unbekanntes Produkt -> NotFoundError', async () => {
    await expect(
      new ProductService(stockDb(undefined).pool).changeStock(9, { mode: 'set', value: 1 }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});
