/** Eingabe-Schemas (Allowlist): was durchkommt, was abgewiesen wird – und dass Fehler keine Eingaben spiegeln. */
import { describe, expect, it } from 'vitest';
import { ValidationError } from '../../src/errors.js';
import {
  createOrderBody,
  createProductBody,
  idParam,
  orderStatusBody,
  orderTokenHeader,
  parse,
  productListQuery,
  stockBody,
  updateProductBody,
  uuidParam,
} from '../../src/schemas/index.js';

const customer = { name: 'Max', street: 'Weg 1', zip: '12345', city: 'Ulm', phone: '0731 123456' };
const ok = (schema: Parameters<typeof parse>[0], input: unknown) => parse(schema, input);
const rejects = (schema: Parameters<typeof parse>[0], input: unknown) => {
  expect(() => parse(schema, input)).toThrow(ValidationError);
};

describe('parse()', () => {
  it('Fehler enthalten Pfad und Meldung, aber nie den Eingabewert', () => {
    try {
      parse(createOrderBody, {
        items: [{ productId: 1, quantity: 1 }],
        customer: { ...customer, zip: '<script>' },
      });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      const details = JSON.stringify((err as ValidationError).details);
      expect(details).toContain('customer.zip');
      expect(details).not.toContain('<script>');
    }
  });
});

describe('createOrderBody', () => {
  it('trimmt Texte und akzeptiert Umlaute', () => {
    const r = ok(createOrderBody, {
      items: [{ productId: 1, quantity: 1 }],
      customer: { ...customer, name: '  Jürgen Öztürk  ' },
    }) as { customer: { name: string } };
    expect(r.customer.name).toBe('Jürgen Öztürk');
  });

  it.each([
    [
      '20 Positionen sind erlaubt',
      Array.from({ length: 20 }, (_, i) => ({ productId: i + 1, quantity: 1 })),
      true,
    ],
    [
      '21 Positionen sind zu viele',
      Array.from({ length: 21 }, (_, i) => ({ productId: i + 1, quantity: 1 })),
      false,
    ],
    ['Menge 0', [{ productId: 1, quantity: 0 }], false],
    ['Menge als Kommazahl', [{ productId: 1, quantity: 1.5 }], false],
    ['Menge als String', [{ productId: 1, quantity: '2' }], false],
    ['productId 0', [{ productId: 0, quantity: 1 }], false],
    ['productId über int32', [{ productId: 2 ** 31, quantity: 1 }], false],
  ])('%s', (_name, items, valid) => {
    if (valid) ok(createOrderBody, { items, customer });
    else rejects(createOrderBody, { items, customer });
  });

  it.each([
    ['Telefon mit Buchstaben', { phone: '0800-CALL-ME' }],
    ['Telefon zu kurz', { phone: '12345' }],
    ['PLZ mit 4 Ziffern', { zip: '1234' }],
    ['Name zu lang', { name: 'x'.repeat(81) }],
    ['Name nur Leerzeichen', { name: '     ' }],
    ['Tabulator im Namen', { name: 'Max\tMuster' }],
    ['Nullbyte in Straße', { street: 'Weg 1\u0000' }],
    ['zusätzliches Feld im Kunden', { email: 'a@b.de' }],
  ])('%s -> abgewiesen', (_name, patch) => {
    rejects(createOrderBody, {
      items: [{ productId: 1, quantity: 1 }],
      customer: { ...customer, ...patch },
    });
  });

  it('fehlender Kunde oder fehlende Positionen -> abgewiesen', () => {
    rejects(createOrderBody, { items: [{ productId: 1, quantity: 1 }] });
    rejects(createOrderBody, { customer });
    rejects(createOrderBody, null);
    rejects(createOrderBody, []);
  });
});

describe('Pfad-, Query- und Header-Parameter', () => {
  it('idParam wandelt Ziffern-Strings um und lehnt alles andere ab', () => {
    expect(ok(idParam, { id: '42' })).toEqual({ id: 42 });
    for (const id of ['-1', '0', '1.5', 'abc', '1e3x', '']) rejects(idParam, { id });
  });

  it('uuidParam akzeptiert nur UUIDs', () => {
    ok(uuidParam, { id: '7f1e4a8e-1b2c-4d3e-8f90-123456789abc' });
    rejects(uuidParam, { id: '../../etc/passwd' });
    rejects(uuidParam, { id: "1' OR '1'='1" });
  });

  it('orderTokenHeader verlangt exakt 43 base64url-Zeichen', () => {
    ok(orderTokenHeader, 'A'.repeat(43));
    rejects(orderTokenHeader, 'A'.repeat(42));
    rejects(orderTokenHeader, 'A'.repeat(44));
    rejects(orderTokenHeader, `${'A'.repeat(42)}=`);
    rejects(orderTokenHeader, undefined);
  });

  it('productListQuery: nur bekannte Kategorien und Parameter', () => {
    ok(productListQuery, { category: 'drink', q: 'cola' });
    ok(productListQuery, {});
    rejects(productListQuery, { category: 'admin' });
    rejects(productListQuery, { q: 'x'.repeat(51) });
    rejects(productListQuery, { sort: 'price' });
  });
});

describe('Admin-Schemas', () => {
  it('createProductBody setzt sichere Defaults', () => {
    expect(ok(createProductBody, { name: 'Hawaii', category: 'pizza', priceCents: 1000 })).toEqual({
      name: 'Hawaii',
      description: '',
      category: 'pizza',
      priceCents: 1000,
      stock: 0,
      active: true,
    });
  });

  it.each([
    ['Preis 0', { priceCents: 0 }],
    ['Preis negativ', { priceCents: -100 }],
    ['Preis über 1000 €', { priceCents: 100_001 }],
    ['Preis als Kommazahl', { priceCents: 9.99 }],
    ['unbekannte Kategorie', { category: 'salad' }],
    ['negativer Bestand', { stock: -1 }],
    ['id von außen', { id: 5 }],
  ])('createProductBody: %s -> abgewiesen', (_name, patch) => {
    rejects(createProductBody, { name: 'Hawaii', category: 'pizza', priceCents: 1000, ...patch });
  });

  it('updateProductBody braucht mindestens ein Feld und kennt kein "stock"', () => {
    ok(updateProductBody, { active: false });
    rejects(updateProductBody, {});
    rejects(updateProductBody, { stock: 5 });
  });

  it('stockBody unterscheidet set (>= 0) und adjust (auch negativ)', () => {
    ok(stockBody, { mode: 'set', value: 0 });
    ok(stockBody, { mode: 'adjust', value: -5 });
    rejects(stockBody, { mode: 'set', value: -1 });
    rejects(stockBody, { mode: 'multiply', value: 2 });
    rejects(stockBody, { mode: 'set' });
  });

  it('orderStatusBody kennt nur definierte Status', () => {
    ok(orderStatusBody, { status: 'cancelled' });
    rejects(orderStatusBody, { status: 'refunded' });
  });
});
