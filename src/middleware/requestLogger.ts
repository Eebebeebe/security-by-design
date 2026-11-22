import { randomUUID } from 'node:crypto';
import type { RequestHandler } from 'express';
import type { Logger } from 'pino';

const INCOMING_ID = /^[A-Za-z0-9_-]{8,64}$/;
const QUIET_PATHS = new Set(['/healthz', '/readyz']);

/**
 * Vergibt jeder Anfrage eine requestId (Korrelation Client-Fehlermeldung <-> Log)
 * und schreibt nach Abschluss genau ein "http.request"-Event.
 * Geloggt wird nur der Pfad OHNE Query-String, damit keine Parameter/Tokens im Log landen.
 */
export function requestLogger(log: Logger): RequestHandler {
  return (req, res, next) => {
    const incoming = req.get('x-request-id');
    // False Positive (regex_dos): eine Zeichenklasse mit fester Obergrenze, kein verschachtelter
    // Quantor -> lineare Laufzeit. Zusätzlich vorher auf 64 Zeichen gekürzt.
    const candidate = incoming?.slice(0, 65);
    const requestId =
      // nosemgrep: ajinabraham.njsscan.dos.regex_dos.regex_dos
      candidate && INCOMING_ID.test(candidate) ? candidate : randomUUID();
    res.locals.requestId = requestId;
    res.locals.log = log.child({ requestId });
    res.setHeader('X-Request-Id', requestId);

    const start = process.hrtime.bigint();
    res.on('finish', () => {
      const durationMs = Number((process.hrtime.bigint() - start) / 1_000_000n);
      const path = req.originalUrl.split('?')[0] ?? '';
      const route = req.route
        ? `${req.baseUrl}${String((req.route as { path: unknown }).path)}`
        : undefined;
      const entry = {
        event: 'http.request',
        method: req.method,
        path,
        route,
        status: res.statusCode,
        durationMs,
        ip: req.ip,
        admin: res.locals.admin?.username,
      };
      if (res.statusCode >= 500) res.locals.log.error(entry, 'request failed');
      else if (res.statusCode >= 400) res.locals.log.warn(entry, 'request rejected');
      else if (QUIET_PATHS.has(path)) res.locals.log.debug(entry, 'probe');
      else res.locals.log.info(entry, 'request completed');
    });
    next();
  };
}
