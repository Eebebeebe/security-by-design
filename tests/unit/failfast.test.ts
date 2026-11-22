/**
 * Positivtests für "Fail Fast" + sichere Defaults (Feld 2, Code Security).
 * Die App läuft hier mit einer Datenbank-Attrappe, die bei JEDEM Zugriff explodiert.
 * Ein 400 statt 500 beweist also: die Eingabe wurde abgewiesen, BEVOR die DB berührt wurde.
 */
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { appWithoutDb, validCustomer } from '../helpers.js';

describe('Fail Fast: ungültige Eingaben erreichen die Datenbank nie', () => {
  const cases: [string, unknown][] = [
    ['leere Bestellung', { items: [], customer: validCustomer }],
    ['negative Menge', { items: [{ productId: 1, quantity: -1 }], customer: validCustomer }],
    ['Menge zu groß', { items: [{ productId: 1, quantity: 999 }], customer: validCustomer }],
    [
      'Preis vom Client (Mass Assignment)',
      { items: [{ productId: 1, quantity: 1, priceCents: 1 }], customer: validCustomer },
    ],
    [
      'SQL im productId',
      { items: [{ productId: '1; DROP TABLE products;--', quantity: 1 }], customer: validCustomer },
    ],
    [
      'doppeltes Produkt',
      {
        items: [
          { productId: 1, quantity: 1 },
          { productId: 1, quantity: 2 },
        ],
        customer: validCustomer,
      },
    ],
    [
      'ungültige PLZ',
      { items: [{ productId: 1, quantity: 1 }], customer: { ...validCustomer, zip: '1234a' } },
    ],
    [
      'Steuerzeichen im Namen (Log Injection)',
      {
        items: [{ productId: 1, quantity: 1 }],
        customer: { ...validCustomer, name: 'Max\n{"level":"fatal"}' },
      },
    ],
    [
      'unbekanntes Feld',
      { items: [{ productId: 1, quantity: 1 }], customer: validCustomer, isAdmin: true },
    ],
  ];

  it.each(cases)('%s -> 400 VALIDATION_FAILED, keine DB-Abfrage', async (_name, body) => {
    const { app, query, connect } = appWithoutDb();
    const res = await request(app)
      .post('/api/orders')
      .send(body as object);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    expect(query).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
  });

  it('ungültige Produkt-ID im Pfad -> 400 ohne DB', async () => {
    const { app, query } = appWithoutDb();
    const res = await request(app).get('/api/products/abc');
    expect(res.status).toBe(400);
    expect(query).not.toHaveBeenCalled();
  });

  it('Order-Lookup ohne gültiges Token-Format -> 400 ohne DB', async () => {
    const { app, query } = appWithoutDb();
    const res = await request(app)
      .get('/api/orders/7f1e4a8e-1b2c-4d3e-8f90-123456789abc')
      .set('X-Order-Token', "' OR 1=1 --");
    expect(res.status).toBe(400);
    expect(query).not.toHaveBeenCalled();
  });

  it('kaputtes JSON -> 400 MALFORMED_REQUEST', async () => {
    const { app } = appWithoutDb();
    const res = await request(app)
      .post('/api/orders')
      .set('Content-Type', 'application/json')
      .send('{"items": [');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('MALFORMED_REQUEST');
  });

  it('zu großer Body (> 10 kB) -> 413', async () => {
    const { app, query } = appWithoutDb();
    const res = await request(app)
      .post('/api/orders')
      .send({ items: [], customer: { ...validCustomer, name: 'x'.repeat(20_000) } });
    expect(res.status).toBe(413);
    expect(query).not.toHaveBeenCalled();
  });
});

describe('Sichere Fehlerbehandlung', () => {
  it('unerwarteter Fehler -> generische 500 ohne Stacktrace/Interna, mit requestId', async () => {
    const { app } = appWithoutDb();
    // Gültige Anfrage -> erreicht die (explodierende) DB
    const res = await request(app).get('/api/products');
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('INTERNAL_ERROR');
    expect(res.body.error.requestId).toBe(res.headers['x-request-id']);
    expect(JSON.stringify(res.body)).not.toMatch(/DB darf nicht|stack|at .*\.ts/);
  });

  it('unbekannter API-Endpunkt -> 404 im Standardformat', async () => {
    const { app } = appWithoutDb();
    const res = await request(app).get('/api/does-not-exist');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('Readiness meldet unhealthy (503), wenn die DB nicht erreichbar ist', async () => {
    const { app } = appWithoutDb();
    const res = await request(app).get('/readyz');
    expect(res.status).toBe(503);
    expect(res.body.checks.database).toBe('down');
  });
});

describe('Sichere Defaults (HTTP-Header & Admin-Schutz)', () => {
  it('setzt Security-Header und verrät kein Framework', async () => {
    const { app } = appWithoutDb();
    const res = await request(app).get('/healthz');
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['content-security-policy']).toContain("script-src 'self'");
    expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
  });

  it('API-Antworten werden nicht gecacht', async () => {
    const { app } = appWithoutDb();
    const res = await request(app).get('/api/does-not-exist');
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('Admin-Endpunkte ohne Session -> 401, ohne DB-Zugriff', async () => {
    const { app, query } = appWithoutDb();
    const res = await request(app).get('/api/admin/products');
    expect(res.status).toBe(401);
    expect(query).not.toHaveBeenCalled();
  });

  it('Admin-Schreibzugriff von fremdem Origin -> 403 (CSRF-Schutz)', async () => {
    const { app } = appWithoutDb();
    const res = await request(app)
      .post('/api/admin/login')
      .set('Origin', 'https://evil.example')
      .send({ username: 'admin', password: 'x' });
    expect(res.status).toBe(403);
  });

  it('Admin-Schreibzugriff als Formular statt JSON -> 403', async () => {
    const { app } = appWithoutDb();
    const res = await request(app)
      .post('/api/admin/login')
      .type('form')
      .send('username=admin&password=x');
    expect(res.status).toBe(403);
  });

  it('übernimmt nur wohlgeformte X-Request-Id vom Client', async () => {
    const { app } = appWithoutDb();
    const ok = await request(app).get('/healthz').set('X-Request-Id', 'abc-12345678');
    expect(ok.headers['x-request-id']).toBe('abc-12345678');
    const bad = await request(app).get('/healthz').set('X-Request-Id', '"><script>injected');
    expect(bad.headers['x-request-id']).not.toContain('injected');
    expect(bad.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });
});
