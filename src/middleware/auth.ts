import type { CookieOptions, Request, RequestHandler } from 'express';
import { ForbiddenError, UnauthorizedError } from '../errors.js';
import type { AuthService } from '../services/authService.js';

export const SESSION_COOKIE = 'pizza_admin';
const TOKEN_FORMAT = /^[A-Za-z0-9_-]{43}$/;

export function sessionCookieOptions(secure: boolean, maxAgeMs?: number): CookieOptions {
  return {
    httpOnly: true, // per JS nicht lesbar -> XSS kann das Token nicht stehlen
    secure, // nur über HTTPS (Default true, siehe config.ts)
    sameSite: 'strict', // Browser sendet das Cookie nicht bei Cross-Site-Requests -> CSRF-Schutz
    path: '/api/admin',
    ...(maxAgeMs !== undefined ? { maxAge: maxAgeMs } : {}),
  };
}

/** Minimaler Cookie-Parser für genau ein Cookie (spart eine Abhängigkeit). */
export function readSessionCookie(req: Request): string | undefined {
  const header = req.get('cookie');
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === SESSION_COOKIE) {
      const value = rest.join('=');
      return TOKEN_FORMAT.test(value) ? value : undefined;
    }
  }
  return undefined;
}

/**
 * Defense in Depth gegen CSRF zusätzlich zu SameSite=Strict:
 * Zustandsändernde Admin-Requests müssen JSON sein (kein simples HTML-Formular möglich)
 * und – falls der Browser einen Origin-Header schickt – vom eigenen Host stammen.
 */
export const sameOriginOnly: RequestHandler = (req, _res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD') {
    next();
    return;
  }
  if (!req.is('application/json')) {
    next(new ForbiddenError('Nur JSON-Anfragen erlaubt.'));
    return;
  }
  const origin = req.get('origin');
  if (origin) {
    let originHost: string | undefined;
    try {
      originHost = new URL(origin).host;
    } catch {
      originHost = undefined;
    }
    if (originHost !== req.get('host')) {
      next(new ForbiddenError('Fremder Origin.'));
      return;
    }
  }
  next();
};

export function requireAdmin(auth: AuthService): RequestHandler {
  return async (req, res, next) => {
    const token = readSessionCookie(req);
    if (!token) throw new UnauthorizedError();
    const admin = await auth.resolveSession(token);
    if (!admin) throw new UnauthorizedError('Sitzung abgelaufen. Bitte neu anmelden.');
    res.locals.admin = admin;
    res.locals.sessionToken = token;
    res.locals.log = res.locals.log.child({ adminId: admin.id });
    next();
  };
}
