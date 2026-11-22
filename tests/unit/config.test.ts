import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../../src/config.js';

const base = {
  DATABASE_URL: 'postgres://u:p@localhost/db',
  ADMIN_PASSWORD: 'a-very-long-password',
};

describe('Konfiguration (Fail Fast beim Start)', () => {
  it('sichere Defaults: production, Secure-Cookies, kein Proxy-Trust', () => {
    const c = loadConfig(base);
    expect(c.NODE_ENV).toBe('production');
    expect(c.COOKIE_SECURE).toBe(true);
    expect(c.TRUST_PROXY).toBe(false);
  });

  it('verweigert Start ohne Admin-Passwort', () => {
    expect(() => loadConfig({ DATABASE_URL: base.DATABASE_URL })).toThrow(ConfigError);
  });

  it('verweigert zu kurze / triviale Passwörter', () => {
    expect(() => loadConfig({ ...base, ADMIN_PASSWORD: 'short' })).toThrow(/mindestens 12/);
    expect(() => loadConfig({ ...base, ADMIN_PASSWORD: '123456789012' })).toThrow(/zu schwach/);
  });

  it('verweigert ungültige Werte', () => {
    expect(() => loadConfig({ ...base, PORT: '99999' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, DATABASE_URL: 'mysql://x' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, COOKIE_SECURE: 'yes' })).toThrow(ConfigError);
  });

  it('gibt in der Fehlermeldung niemals den geheimen Wert aus', () => {
    try {
      loadConfig({ ...base, ADMIN_PASSWORD: 'geheim' });
      expect.unreachable();
    } catch (err) {
      expect(String(err)).not.toContain('geheim');
    }
  });
});
