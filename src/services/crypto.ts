import { createHash, randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';

/**
 * Passwort-Hashing mit scrypt (in Node eingebaut -> keine zusätzliche Abhängigkeit).
 * Format: scrypt$N$r$p$saltB64$hashB64 – Parameter werden mitgespeichert,
 * damit sie später erhöht werden können, ohne alte Hashes ungültig zu machen.
 */
const N = 16384;
const R = 8;
const P = 1;
const KEYLEN = 64;

function scryptAsync(
  password: string,
  salt: Buffer,
  keylen: number,
  opts: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keylen, opts, (err, key) => {
      if (err) reject(err);
      else resolve(key);
    });
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scryptAsync(password, salt, KEYLEN, { N, r: R, p: P });
  return ['scrypt', N, R, P, salt.toString('base64'), hash.toString('base64')].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, saltB64, hashB64] = parts as [string, string, string, string, string, string];
  const expected = Buffer.from(hashB64, 'base64');
  const actual = await scryptAsync(password, Buffer.from(saltB64, 'base64'), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    maxmem: 64 * 1024 * 1024,
  });
  // Konstante Laufzeit beim Vergleich -> kein Timing-Orakel.
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** Kryptographisch zufälliges, URL-sicheres Token (256 Bit -> 43 Zeichen base64url). */
export function randomToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Tokens werden nur gehasht gespeichert. SHA-256 reicht, da die Tokens 256 Bit Entropie haben. */
export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function safeEqualHex(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}
