import type { ErrorRequestHandler, RequestHandler } from 'express';
import { AppError, NotFoundError } from '../errors.js';

/** Unbekannte API-Routen -> saubere 404 im einheitlichen Fehlerformat. */
export const apiNotFound: RequestHandler = (_req, _res, next) => {
  next(new NotFoundError('Endpunkt'));
};

interface BodyParserError {
  type: string;
  status: number;
}
function isBodyParserError(err: unknown): err is BodyParserError {
  return typeof err === 'object' && err !== null && 'type' in err && 'status' in err;
}

/**
 * Zentrale Fehlerbehandlung.
 *  - Bekannte Fehler (AppError) -> definierter Status + stabiler Code + sichere Meldung
 *  - Fehler des Body-Parsers (kaputtes JSON, zu groß) -> 400 / 413
 *  - alles andere -> 500 mit generischer Meldung; Stacktrace NUR ins Log, nie zum Client
 * Der Client bekommt immer die requestId, damit Support den Log-Eintrag findet.
 */
export const errorHandler: ErrorRequestHandler = (err: unknown, _req, res, next) => {
  if (res.headersSent) {
    next(err);
    return;
  }
  const requestId = res.locals.requestId;
  const log = res.locals.log;

  if (err instanceof AppError) {
    log.warn(
      { event: 'app.error.handled', code: err.code, status: err.status, details: err.details },
      err.message,
    );
    res.status(err.status).json({
      error: { code: err.code, message: err.publicMessage, details: err.details, requestId },
    });
    return;
  }

  if (isBodyParserError(err)) {
    const tooLarge = err.type === 'entity.too.large';
    const status = tooLarge ? 413 : 400;
    const code = tooLarge ? 'PAYLOAD_TOO_LARGE' : 'MALFORMED_REQUEST';
    log.warn(
      { event: 'app.error.handled', code, status, parserType: err.type },
      'body parser rejected request',
    );
    res.status(status).json({
      error: {
        code,
        message: tooLarge ? 'Anfrage zu groß.' : 'Anfrage konnte nicht gelesen werden.',
        requestId,
      },
    });
    return;
  }

  log.error({ event: 'app.error.unhandled', err }, 'unhandled error');
  res.status(500).json({
    error: {
      code: 'INTERNAL_ERROR',
      message: 'Interner Fehler. Bitte später erneut versuchen.',
      requestId,
    },
  });
};
