import { describe, expect, it } from 'vitest';
import { hashPassword, randomToken, sha256Hex, verifyPassword } from '../../src/services/crypto.js';

describe('Passwort-Hashing & Tokens', () => {
  it('hash ist gesalzen und verifizierbar', async () => {
    const a = await hashPassword('correct horse battery');
    const b = await hashPassword('correct horse battery');
    expect(a).not.toBe(b); // unterschiedliches Salt
    expect(a.startsWith('scrypt$')).toBe(true);
    expect(await verifyPassword('correct horse battery', a)).toBe(true);
    expect(await verifyPassword('wrong', a)).toBe(false);
  });

  it('kaputte Hash-Formate werden sicher abgelehnt', async () => {
    expect(await verifyPassword('x', 'plaintext')).toBe(false);
    expect(await verifyPassword('x', 'md5$abc')).toBe(false);
  });

  it('Tokens sind 256 Bit, URL-sicher und eindeutig', () => {
    const tokens = new Set(Array.from({ length: 100 }, () => randomToken()));
    expect(tokens.size).toBe(100);
    for (const t of tokens) expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(sha256Hex('a')).toHaveLength(64);
  });
});
