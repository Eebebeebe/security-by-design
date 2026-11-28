/** Admin-Schutz (Cookie, CSRF) und zentrale Fehlerbehandlung als isolierte Einheiten. */
import type { NextFunction, Request, Response } from 'express';
import { pino } from 'pino';
import { describe, expect, it, vi } from 'vitest';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  OutOfStockError,
  UnauthorizedError,
  ValidationError,
} from '../../src/errors.js';
import {
  readSessionCookie,
  requireAdmin,
  sameOriginOnly,
  SESSION_COOKIE,
  sessionCookieOptions,
} from '../../src/middleware/auth.js';
import { errorHandler } from '../../src/middleware/errorHandler.js';
import type { AuthService } from '../../src/services/authService.js';

const TOKEN = 'a'.repeat(43);

function fakeReq(opts: { method?: string; headers?: Record<string, string>; json?: boolean } = {}) {
  const headers = Object.fromEntries(
    Object.entries(opts.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
  );
  return {
    method: opts.method ?? 'GET',
    get: (name: string) => headers[name.toLowerCase()],
    is: (type: string) => (opts.json && type === 'application/json' ? type : false),
  } as unknown as Request;
}

function fakeRes() {
  const res = {
    headersSent: false,
    statusCode: 200,
    body: undefined as unknown,
    locals: { requestId: 'req-1', log: pino({ level: 'silent' }) },
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(body: unknown) {
      res.body = body;
      return res;
    },
  };
  return res;
}

describe('readSessionCookie', () => {
  it('findet das Session-Cookie zwischen anderen Cookies', () => {
    const req = fakeReq({ headers: { cookie: `theme=dark; ${SESSION_COOKIE}=${TOKEN}; lang=de` } });
    expect(readSessionCookie(req)).toBe(TOKEN);
  });

  it.each([
    ['kein Cookie-Header', undefined],
    ['anderes Cookie', 'other=1'],
    ['zu kurzes Token', `${SESSION_COOKIE}=abc`],
    ['Sonderzeichen im Token', `${SESSION_COOKIE}=${'a'.repeat(42)};`],
    ['Injection-Versuch', `${SESSION_COOKIE}=' OR 1=1 --`],
  ])('%s -> undefined', (_name, cookie) => {
    const req = fakeReq(cookie === undefined ? {} : { headers: { cookie } });
    expect(readSessionCookie(req)).toBeUndefined();
  });
});

describe('sessionCookieOptions', () => {
  it('HttpOnly, SameSite=Strict, auf /api/admin beschränkt', () => {
    expect(sessionCookieOptions(true, 1000)).toEqual({
      httpOnly: true,
      secure: true,
      sameSite: 'strict',
      path: '/api/admin',
      maxAge: 1000,
    });
  });

  it('ohne maxAge (Logout) kein maxAge-Feld', () => {
    expect(sessionCookieOptions(false)).not.toHaveProperty('maxAge');
  });
});

describe('sameOriginOnly (CSRF-Schutz)', () => {
  const run = (req: Request) => {
    const next = vi.fn();
    sameOriginOnly(req, {} as unknown as Response, next as NextFunction);
    return next.mock.calls[0]?.[0] as unknown;
  };

  it('lesende Anfragen passieren immer', () => {
    expect(
      run(fakeReq({ method: 'GET', headers: { origin: 'https://evil.example' } })),
    ).toBeUndefined();
    expect(run(fakeReq({ method: 'HEAD' }))).toBeUndefined();
  });

  it('JSON vom eigenen Host passiert', () => {
    const req = fakeReq({
      method: 'POST',
      json: true,
      headers: { origin: 'http://shop.local:3000', host: 'shop.local:3000' },
    });
    expect(run(req)).toBeUndefined();
  });

  it('JSON ohne Origin-Header (z.B. curl) passiert', () => {
    expect(
      run(fakeReq({ method: 'PATCH', json: true, headers: { host: 'shop.local' } })),
    ).toBeUndefined();
  });

  it.each([
    ['kein JSON', { method: 'POST', json: false, headers: { host: 'shop.local' } }],
    [
      'fremder Origin',
      {
        method: 'POST',
        json: true,
        headers: { origin: 'https://evil.example', host: 'shop.local' },
      },
    ],
    [
      'Origin "null" (Sandbox/iframe)',
      { method: 'DELETE', json: true, headers: { origin: 'null', host: 'shop.local' } },
    ],
    [
      'ähnlicher Host',
      {
        method: 'POST',
        json: true,
        headers: { origin: 'https://shop.local.evil.example', host: 'shop.local' },
      },
    ],
  ])('%s -> ForbiddenError', (_name, opts) => {
    expect(run(fakeReq(opts))).toBeInstanceOf(ForbiddenError);
  });
});

describe('requireAdmin', () => {
  const auth = (admin: { id: number; username: string } | null) =>
    ({ resolveSession: vi.fn(() => Promise.resolve(admin)) }) as unknown as AuthService;

  it('ohne Cookie -> UnauthorizedError, ohne DB-Abfrage', async () => {
    const resolveSession = vi.fn(() => Promise.resolve(null));
    const service = { resolveSession } as unknown as AuthService;
    await expect(
      requireAdmin(service)(fakeReq(), fakeRes() as unknown as Response, vi.fn()),
    ).rejects.toBeInstanceOf(UnauthorizedError);
    expect(resolveSession).not.toHaveBeenCalled();
  });

  it('abgelaufene/unbekannte Session -> UnauthorizedError', async () => {
    const req = fakeReq({ headers: { cookie: `${SESSION_COOKIE}=${TOKEN}` } });
    await expect(
      requireAdmin(auth(null))(req, fakeRes() as unknown as Response, vi.fn()),
    ).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('gültige Session -> Admin in res.locals, next() wird aufgerufen', async () => {
    const req = fakeReq({ headers: { cookie: `${SESSION_COOKIE}=${TOKEN}` } });
    const res = fakeRes();
    const next = vi.fn();
    await requireAdmin(auth({ id: 1, username: 'admin' }))(req, res as unknown as Response, next);
    expect(next).toHaveBeenCalledWith();
    expect((res.locals as { admin?: unknown }).admin).toEqual({ id: 1, username: 'admin' });
  });
});

describe('errorHandler', () => {
  const handle = (err: unknown) => {
    const res = fakeRes();
    errorHandler(err, fakeReq(), res as unknown as Response, vi.fn());
    return res as { statusCode: number; body: { error: Record<string, unknown> } };
  };

  const cases: [Error, number, string][] = [
    [new ValidationError([{ path: 'x', message: 'falsch' }]), 400, 'VALIDATION_FAILED'],
    [new UnauthorizedError(), 401, 'UNAUTHORIZED'],
    [new ForbiddenError(), 403, 'FORBIDDEN'],
    [new NotFoundError('Produkt'), 404, 'NOT_FOUND'],
    [new OutOfStockError([1]), 409, 'OUT_OF_STOCK'],
    [new ConflictError('X', 'y'), 409, 'X'],
  ];
  it.each(cases)('%s -> %i %s', (err, status, code) => {
    const res = handle(err);
    expect(res.statusCode).toBe(status);
    expect(res.body.error).toMatchObject({ code, requestId: 'req-1' });
  });

  it('Body-Parser-Fehler: kaputtes JSON 400, zu groß 413', () => {
    expect(handle({ type: 'entity.parse.failed', status: 400 }).statusCode).toBe(400);
    expect(handle({ type: 'entity.too.large', status: 413 }).body.error.code).toBe(
      'PAYLOAD_TOO_LARGE',
    );
  });

  it('unerwarteter Fehler -> 500 ohne interne Details', () => {
    const res = handle(new Error('password authentication failed for user "pizza" at 10.0.0.5'));
    expect(res.statusCode).toBe(500);
    expect(JSON.stringify(res.body)).not.toMatch(/password|10\.0\.0\.5|stack/);
  });

  it('auch Nicht-Error-Werte (throw "string") werden sicher behandelt', () => {
    expect(handle('kaputt').statusCode).toBe(500);
    expect(handle(undefined).statusCode).toBe(500);
  });

  it('wenn die Antwort schon gesendet wurde, wird an Express weitergereicht', () => {
    const res = fakeRes();
    res.headersSent = true;
    const next = vi.fn();
    const err = new Error('late');
    errorHandler(err, fakeReq(), res as unknown as Response, next);
    expect(next).toHaveBeenCalledWith(err);
  });
});
