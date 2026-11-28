import { pino, type Logger } from 'pino';

/**
 * Strukturiertes JSON-Logging (eine Zeile = ein Event) nach STDOUT und optional in eine Datei.
 *
 * Konventionen (siehe docs/SCHUTZKONZEPT.md, Feld 4):
 *  - jedes fachlich relevante Log hat ein maschinenlesbares Feld `event`, z.B. "order.created"
 *  - Request-bezogene Logs tragen `requestId` (auch im Response-Header X-Request-Id)
 *  - Geheimnisse / personenbezogene Daten werden per `redact` entfernt
 */
export const REDACT_PATHS = [
  'password',
  '*.password',
  'token',
  '*.token',
  'trackingToken',
  '*.trackingToken',
  'phone',
  '*.phone',
  'req.headers.cookie',
  'req.headers.authorization',
  'req.headers["x-order-token"]',
  'res.headers["set-cookie"]',
];

export interface LoggerOptions {
  level: string;
  file?: string | undefined;
  /** Nur für Tests: Logs in diesen Stream statt nach STDOUT schreiben. */
  destination?: pino.DestinationStream | undefined;
}

export function createLogger(opts: LoggerOptions): Logger {
  const base = {
    level: opts.level,
    base: { service: 'pizza-shop' },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
    formatters: {
      // "level": "info" statt Zahl -> für Menschen lesbar, für Tools trotzdem eindeutig.
      level: (label: string, number: number) => ({ level: label, levelValue: number }),
    },
  };
  if (opts.destination) {
    return pino(base, opts.destination);
  }
  if (!opts.file) {
    return pino(base);
  }
  const streams = pino.multistream([
    { stream: process.stdout, level: opts.level as pino.Level },
    {
      stream: pino.destination({ dest: opts.file, mkdir: true, sync: false }),
      level: opts.level as pino.Level,
    },
  ]);
  return pino(base, streams);
}

export type { Logger };
