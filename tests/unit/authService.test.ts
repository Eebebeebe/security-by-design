/** Login & Sessions ohne Datenbank: keine Klartext-Tokens, keine Enumeration, Ablaufzeit. */
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { AuthService } from '../../src/services/authService.js';
import { hashPassword, sha256Hex } from '../../src/services/crypto.js';
import { fakePool } from './fakeDb.js';

const log = pino({ level: 'silent' });
const PASSWORD = 'test-correct-password';
const storedHash = await hashPassword(PASSWORD);

function userDb() {
  return fakePool((sql) =>
    sql.startsWith('SELECT id, username, password_hash')
      ? { rows: [{ id: 7, username: 'admin', password_hash: storedHash }] }
      : undefined,
  );
}

describe('AuthService.login', () => {
  it('erfolgreicher Login speichert nur den Hash des Session-Tokens', async () => {
    const db = userDb();
    const result = await new AuthService(db.pool, log, 60).login('admin', PASSWORD);
    expect(result?.admin).toEqual({ id: 7, username: 'admin' });
    const insert = db.find(/^INSERT INTO admin_sessions/)[0];
    expect(insert?.params[0]).toBe(sha256Hex(result?.token ?? ''));
    expect(insert?.params).not.toContain(result?.token);
  });

  it('Session läuft nach der konfigurierten TTL ab', async () => {
    const before = Date.now();
    const result = await new AuthService(userDb().pool, log, 30).login('admin', PASSWORD);
    const ttl = (result?.expiresAt.getTime() ?? 0) - before;
    expect(ttl).toBeGreaterThanOrEqual(30 * 60_000 - 1000);
    expect(ttl).toBeLessThanOrEqual(30 * 60_000 + 1000);
  });

  it('jeder Login erzeugt ein neues Token (keine Session Fixation)', async () => {
    const service = new AuthService(userDb().pool, log, 60);
    const a = await service.login('admin', PASSWORD);
    const b = await service.login('admin', PASSWORD);
    expect(a?.token).not.toBe(b?.token);
  });

  it('räumt abgelaufene Sessions beim Login auf', async () => {
    const db = userDb();
    await new AuthService(db.pool, log, 60).login('admin', PASSWORD);
    expect(db.find(/^DELETE FROM admin_sessions WHERE expires_at < now\(\)/)).toHaveLength(1);
  });

  it('falsches Passwort -> null, keine Session', async () => {
    const db = userDb();
    expect(await new AuthService(db.pool, log, 60).login('admin', 'falsch')).toBeNull();
    expect(db.find(/^INSERT INTO admin_sessions/)).toHaveLength(0);
  });

  it('unbekannter Benutzer -> null und trotzdem Hash-Berechnung (gleiche Laufzeit)', async () => {
    const db = fakePool();
    const service = new AuthService(db.pool, log, 60);
    const t0 = performance.now();
    expect(await service.login('nobody', 'egal')).toBeNull();
    const unknownMs = performance.now() - t0;
    // scrypt braucht spürbar Zeit; ohne Dummy-Hash wäre die Antwort quasi sofort da.
    expect(unknownMs).toBeGreaterThan(5);
    expect(db.find(/^INSERT/)).toHaveLength(0);
  });
});

describe('AuthService Sessions', () => {
  it('resolveSession sucht nur per Hash und nur nicht abgelaufene Sessions', async () => {
    const db = fakePool();
    expect(await new AuthService(db.pool, log, 60).resolveSession('T'.repeat(43))).toBeNull();
    expect(db.calls[0]?.params).toEqual([sha256Hex('T'.repeat(43))]);
    expect(db.calls[0]?.sql).toContain('s.expires_at > now()');
  });

  it('logout löscht die Session per Hash', async () => {
    const db = fakePool();
    await new AuthService(db.pool, log, 60).logout('T'.repeat(43));
    expect(db.calls[0]).toEqual({
      sql: 'DELETE FROM admin_sessions WHERE token_hash = $1',
      params: [sha256Hex('T'.repeat(43))],
    });
  });

  it('ensureAdmin überschreibt ein bestehendes Passwort nicht', async () => {
    const db = fakePool(() => ({ rowCount: 0 }));
    await new AuthService(db.pool, log, 60).ensureAdmin('admin', 'test-new-password');
    expect(db.calls[0]?.sql).toContain('ON CONFLICT (username) DO NOTHING');
    expect(String(db.calls[0]?.params[1])).toMatch(/^scrypt\$/);
  });
});
