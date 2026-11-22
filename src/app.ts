import express, { type Express } from 'express';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { fileURLToPath } from 'node:url';
import type { Logger } from 'pino';
import type { Config } from './config.js';
import type { Pool } from './db/pool.js';
import { healthRouter, HealthService } from './health.js';
import { apiNotFound, errorHandler } from './middleware/errorHandler.js';
import { requestLogger } from './middleware/requestLogger.js';
import { adminRouter } from './routes/admin.js';
import { shopRouter } from './routes/shop.js';
import { AuthService } from './services/authService.js';
import { OrderService } from './services/orderService.js';
import { ProductService } from './services/productService.js';

const PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url));

export interface AppDeps {
  config: Config;
  pool: Pool;
  log: Logger;
  health: HealthService;
}

export interface AppContext {
  app: Express;
  auth: AuthService;
}

/**
 * Baut die Express-App. Alle Abhängigkeiten werden hereingereicht (testbar, keine globalen Singletons).
 * Die Reihenfolge der Middleware ist sicherheitsrelevant und hier bewusst festgelegt.
 */
export function createApp({ config, pool, log, health }: AppDeps): AppContext {
  const app = express();
  const products = new ProductService(pool);
  const orders = new OrderService(pool);
  const auth = new AuthService(pool, log, config.SESSION_TTL_MINUTES);

  // --- sichere Defaults ---
  app.disable('x-powered-by'); // kein Framework-Fingerprinting
  app.set('trust proxy', config.TRUST_PROXY); // nur hinter bekanntem Proxy X-Forwarded-For vertrauen
  app.set('query parser', 'simple'); // keine verschachtelten Objekte aus ?a[b]=c

  app.use(requestLogger(log));
  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: true,
        directives: {
          'default-src': ["'self'"],
          'script-src': ["'self'"], // kein Inline-JS -> XSS-Payloads werden nicht ausgeführt
          'style-src': ["'self'"],
          'img-src': ["'self'", 'data:'],
          'connect-src': ["'self'"],
          'object-src': ["'none'"],
          'frame-ancestors': ["'none'"], // Clickjacking
          'form-action': ["'self'"],
          'upgrade-insecure-requests': config.COOKIE_SECURE ? [] : null,
        },
      },
      strictTransportSecurity: config.COOKIE_SECURE,
      crossOriginEmbedderPolicy: true,
      referrerPolicy: { policy: 'no-referrer' },
    }),
  );
  app.use((_req, res, next) => {
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    next();
  });

  // Health-Endpunkte vor dem Rate-Limit, damit Monitoring nie gedrosselt wird.
  app.use(healthRouter(health));

  // Grobe Drosselung der gesamten API gegen Missbrauch/DoS.
  app.use(
    '/api',
    rateLimit({ windowMs: 60_000, limit: 300, standardHeaders: 'draft-8', legacyHeaders: false }),
  );
  // Nur JSON, max. 10 kB – größere Bodies werden vor der Verarbeitung abgewiesen.
  app.use('/api', express.json({ limit: '10kb', strict: true }));
  // API-Antworten nie cachen (enthalten u.U. personenbezogene Daten).
  app.use('/api', (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  app.use('/api', shopRouter(products, orders));
  app.use(
    '/api/admin',
    adminRouter({
      auth,
      products,
      orders,
      cookieSecure: config.COOKIE_SECURE,
      sessionTtlMinutes: config.SESSION_TTL_MINUTES,
      loginRateLimit: config.LOGIN_RATE_LIMIT,
    }),
  );
  app.use('/api', apiNotFound);

  app.use(express.static(PUBLIC_DIR, { index: 'index.html', dotfiles: 'ignore', redirect: false }));

  app.use(errorHandler);
  return { app, auth };
}
