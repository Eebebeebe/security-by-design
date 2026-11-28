/** Logging & Health als Einheiten: Schwärzung, Log-Format, Request-Log ohne Query, Health-Zustände. */
import { Writable } from 'node:stream';
import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HealthService } from '../../src/health.js';
import { createLogger } from '../../src/logger.js';
import { requestLogger } from '../../src/middleware/requestLogger.js';
import { fakePool } from './fakeDb.js';

function captureLogger(level = 'trace') {
  const lines: Record<string, unknown>[] = [];
  const destination = new Writable({
    write(chunk: Buffer, _enc, cb) {
      for (const line of chunk.toString().split('\n').filter(Boolean))
        lines.push(JSON.parse(line) as Record<string, unknown>);
      cb();
    },
  });
  return { log: createLogger({ level, destination }), lines };
}

describe('Logger', () => {
  it('schreibt JSON mit Zeitstempel, Level als Text und Zahl, Service-Name', () => {
    const { log, lines } = captureLogger();
    log.warn({ event: 'x.y' }, 'msg');
    expect(lines[0]).toMatchObject({
      level: 'warn',
      levelValue: 40,
      service: 'pizza-shop',
      event: 'x.y',
      msg: 'msg',
    });
    expect(Date.parse(String(lines[0]?.time))).not.toBeNaN();
  });

  it('schwärzt Passwörter, Tokens, Telefonnummern und Cookies', () => {
    const { log, lines } = captureLogger();
    log.info({
      password: 'p1',
      token: 't1',
      trackingToken: 't2',
      phone: '+49 1',
      customer: { phone: '+49 2', password: 'p2' },
      req: {
        headers: { cookie: 'pizza_admin=abc', authorization: 'Bearer x', 'x-order-token': 'y' },
      },
    });
    const text = JSON.stringify(lines[0]);
    for (const secret of [
      'p1',
      'p2',
      't1',
      't2',
      '+49 1',
      '+49 2',
      'pizza_admin=abc',
      'Bearer x',
      '"y"',
    ]) {
      expect(text).not.toContain(secret);
    }
    expect(text).toContain('[REDACTED]');
  });

  it('Steuerzeichen in Werten werden als JSON escaped (keine gefälschten Logzeilen)', () => {
    const { log, lines } = captureLogger();
    log.info({ username: 'evil\n{"level":"fatal","event":"fake"}' });
    expect(lines).toHaveLength(1);
    expect(lines[0]?.username).toContain('\n');
  });

  it('respektiert das Log-Level', () => {
    const { log, lines } = captureLogger('warn');
    log.info('nicht sichtbar');
    log.error('sichtbar');
    expect(lines.map((l) => l.msg)).toEqual(['sichtbar']);
  });
});

describe('requestLogger', () => {
  function app() {
    const cap = captureLogger();
    const a = express();
    a.use(requestLogger(cap.log));
    a.get('/api/orders/:id', (_req, res) => {
      res.json({ ok: true });
    });
    a.get('/boom', (_req, res) => {
      res.status(503).end();
    });
    a.get('/healthz', (_req, res) => {
      res.end();
    });
    return { a, lines: cap.lines };
  }
  const httpEvents = (lines: Record<string, unknown>[]) =>
    lines.filter((l) => l.event === 'http.request');

  it('loggt Pfad und Route, aber nie den Query-String', async () => {
    const { a, lines } = app();
    await request(a).get('/api/orders/123?token=geheim&x=1');
    const entry = httpEvents(lines)[0];
    expect(entry).toMatchObject({
      method: 'GET',
      path: '/api/orders/123',
      route: '/api/orders/:id',
      status: 200,
    });
    expect(JSON.stringify(lines)).not.toContain('geheim');
    expect(typeof entry?.durationMs).toBe('number');
  });

  it('Log-Level folgt dem Status: 5xx error, 4xx warn, Health-Probes nur debug', async () => {
    const { a, lines } = app();
    await request(a).get('/boom');
    await request(a).get('/gibt-es-nicht');
    await request(a).get('/healthz');
    expect(httpEvents(lines).map((l) => [l.status, l.level])).toEqual([
      [503, 'error'],
      [404, 'warn'],
      [200, 'debug'],
    ]);
  });

  it('requestId im Log entspricht dem Response-Header', async () => {
    const { a, lines } = app();
    const res = await request(a).get('/healthz');
    expect(httpEvents(lines)[0]?.requestId).toBe(res.headers['x-request-id']);
  });
});

describe('HealthService', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const health = (respond: Parameters<typeof fakePool>[0], expected = 2) =>
    new HealthService(fakePool(respond).pool, expected);

  it('healthy, wenn DB antwortet und alle Migrationen angewendet sind', async () => {
    const r = await health((sql) =>
      sql.includes('schema_migrations') ? { rows: [{ n: 2 }] } : undefined,
    ).check();
    expect(r).toMatchObject({ status: 'healthy', checks: { database: 'up', migrations: 'ok' } });
  });

  it('unhealthy (pending), wenn Migrationen fehlen', async () => {
    const r = await health((sql) =>
      sql.includes('schema_migrations') ? { rows: [{ n: 1 }] } : undefined,
    ).check();
    expect(r).toMatchObject({
      status: 'unhealthy',
      checks: { database: 'up', migrations: 'pending' },
    });
  });

  it('unhealthy (pending), wenn die Migrationstabelle fehlt, DB aber erreichbar ist', async () => {
    const r = await health((sql) =>
      sql.includes('schema_migrations') ? new Error('relation does not exist') : undefined,
    ).check();
    expect(r.checks).toEqual({ database: 'up', migrations: 'pending' });
  });

  it('unhealthy (down), wenn die DB einen Fehler liefert', async () => {
    const r = await health(() => new Error('ECONNREFUSED')).check();
    expect(r).toMatchObject({
      status: 'unhealthy',
      checks: { database: 'down', migrations: 'unknown' },
    });
  });

  it('hängende DB wird nach 2 s als down gemeldet (Timeout)', async () => {
    vi.useFakeTimers();
    const pending = health(() => new Promise(() => undefined)).check();
    await vi.advanceTimersByTimeAsync(2_001);
    expect((await pending).checks.database).toBe('down');
  });

  it('Heartbeat schreibt healthy als info und unhealthy als error', async () => {
    const ok = captureLogger();
    const stopOk = health((sql) =>
      sql.includes('schema_migrations') ? { rows: [{ n: 2 }] } : undefined,
    ).startHeartbeat(ok.log, 60_000);
    const bad = captureLogger();
    const stopBad = health(() => new Error('down')).startHeartbeat(bad.log, 60_000);
    await vi.waitFor(() => {
      expect(ok.lines.length + bad.lines.length).toBe(2);
    });
    stopOk();
    stopBad();
    expect(ok.lines[0]).toMatchObject({
      event: 'health.heartbeat',
      status: 'healthy',
      level: 'info',
      intervalMs: 60_000,
    });
    expect(bad.lines[0]).toMatchObject({
      event: 'health.heartbeat',
      status: 'unhealthy',
      level: 'error',
    });
  });
});
