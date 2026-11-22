import type { Logger } from 'pino';
import type { Pool } from '../db/pool.js';
import { hashPassword, randomToken, sha256Hex, verifyPassword } from './crypto.js';

export interface AdminIdentity {
  id: number;
  username: string;
}

// Wird bei unbekanntem Benutzernamen verglichen, damit die Antwortzeit gleich bleibt
// (sonst könnte man über Timing gültige Benutzernamen erraten).
let dummyHash: Promise<string> | undefined;

export class AuthService {
  constructor(
    private readonly pool: Pool,
    private readonly log: Logger,
    private readonly sessionTtlMinutes: number,
  ) {}

  /**
   * Legt den Admin beim ersten Start an. Existiert er bereits, wird das Passwort NICHT
   * überschrieben (Rotation bewusst über SQL / neuen Benutzer, siehe README).
   */
  async ensureAdmin(username: string, password: string): Promise<void> {
    const hash = await hashPassword(password);
    const { rowCount } = await this.pool.query(
      `INSERT INTO admin_users (username, password_hash) VALUES ($1, $2)
       ON CONFLICT (username) DO NOTHING`,
      [username, hash],
    );
    if (rowCount) {
      this.log.info({ event: 'admin.bootstrap', username }, 'Admin-Benutzer angelegt');
    }
  }

  /** Liefert bei Erfolg ein neues Session-Token, sonst null. Unterscheidet NICHT nach Ursache. */
  async login(
    username: string,
    password: string,
  ): Promise<{ token: string; admin: AdminIdentity; expiresAt: Date } | null> {
    const { rows } = await this.pool.query<{ id: number; username: string; password_hash: string }>(
      'SELECT id, username, password_hash FROM admin_users WHERE username = $1',
      [username],
    );
    const user = rows[0];
    if (!user) {
      dummyHash ??= hashPassword('dummy-password-for-timing');
      await verifyPassword(password, await dummyHash);
      return null;
    }
    if (!(await verifyPassword(password, user.password_hash))) {
      return null;
    }
    const token = randomToken();
    const expiresAt = new Date(Date.now() + this.sessionTtlMinutes * 60_000);
    await this.pool.query(
      'INSERT INTO admin_sessions (token_hash, admin_id, expires_at) VALUES ($1, $2, $3)',
      [sha256Hex(token), user.id, expiresAt],
    );
    await this.pool.query('UPDATE admin_users SET last_login_at = now() WHERE id = $1', [user.id]);
    // Aufräumen abgelaufener Sessions nebenbei – kein Cronjob nötig.
    await this.pool.query('DELETE FROM admin_sessions WHERE expires_at < now()');
    return { token, admin: { id: user.id, username: user.username }, expiresAt };
  }

  async resolveSession(token: string): Promise<AdminIdentity | null> {
    const { rows } = await this.pool.query<AdminIdentity>(
      `SELECT u.id, u.username FROM admin_sessions s
         JOIN admin_users u ON u.id = s.admin_id
        WHERE s.token_hash = $1 AND s.expires_at > now()`,
      [sha256Hex(token)],
    );
    return rows[0] ?? null;
  }

  async logout(token: string): Promise<void> {
    await this.pool.query('DELETE FROM admin_sessions WHERE token_hash = $1', [sha256Hex(token)]);
  }
}
