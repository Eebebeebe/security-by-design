import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { UnauthorizedError } from '../errors.js';
import {
  readSessionCookie,
  requireAdmin,
  sameOriginOnly,
  SESSION_COOKIE,
  sessionCookieOptions,
} from '../middleware/auth.js';
import {
  adminOrdersQuery,
  createProductBody,
  idParam,
  loginBody,
  orderStatusBody,
  parse,
  stockBody,
  updateProductBody,
  uuidParam,
} from '../schemas/index.js';
import type { AuthService } from '../services/authService.js';
import type { OrderService } from '../services/orderService.js';
import type { ProductService } from '../services/productService.js';

export interface AdminRouterDeps {
  auth: AuthService;
  products: ProductService;
  orders: OrderService;
  cookieSecure: boolean;
  sessionTtlMinutes: number;
  loginRateLimit: number;
}

/**
 * Admin-API (privilegierte Vorgänge). Reihenfolge der Schutzschichten:
 *   sameOriginOnly -> (Login: Rate-Limit) -> requireAdmin -> Validierung -> Aktion -> Audit-Log
 */
export function adminRouter(d: AdminRouterDeps): Router {
  const r = Router();
  r.use(sameOriginOnly);

  // Brute-Force-Bremse: max. N Login-Versuche pro IP und 15 Minuten.
  const loginLimiter = rateLimit({
    windowMs: 15 * 60_000,
    limit: d.loginRateLimit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (_req, res) => {
      res.locals.log.warn({ event: 'admin.login.rate_limited' }, 'login rate limit hit');
      res.status(429).json({
        error: {
          code: 'TOO_MANY_REQUESTS',
          message: 'Zu viele Anmeldeversuche.',
          requestId: res.locals.requestId,
        },
      });
    },
  });

  r.post('/login', loginLimiter, async (req, res) => {
    const { username, password } = parse(loginBody, req.body);
    const result = await d.auth.login(username, password);
    if (!result) {
      res.locals.log.warn({ event: 'admin.login.failed', username }, 'admin login failed');
      // Gleiche Meldung für "Benutzer unbekannt" und "Passwort falsch".
      throw new UnauthorizedError('Benutzername oder Passwort falsch.');
    }
    res.locals.log.info(
      { event: 'admin.login.succeeded', adminId: result.admin.id, username },
      'admin login',
    );
    res.cookie(
      SESSION_COOKIE,
      result.token,
      sessionCookieOptions(d.cookieSecure, d.sessionTtlMinutes * 60_000),
    );
    res.json({ admin: { username: result.admin.username }, expiresAt: result.expiresAt });
  });

  r.post('/logout', async (req, res) => {
    const token = readSessionCookie(req);
    if (token) await d.auth.logout(token);
    res.clearCookie(SESSION_COOKIE, sessionCookieOptions(d.cookieSecure));
    res.locals.log.info({ event: 'admin.logout' }, 'admin logout');
    res.status(204).end();
  });

  // ---- ab hier nur mit gültiger Session ----
  r.use(requireAdmin(d.auth));

  r.get('/me', (_req, res) => {
    res.json({ admin: { username: res.locals.admin?.username } });
  });

  r.get('/products', async (_req, res) => {
    res.json({ products: await d.products.listAll() });
  });

  r.post('/products', async (req, res) => {
    const input = parse(createProductBody, req.body);
    const product = await d.products.create(input);
    res.locals.log.info(
      { event: 'audit', action: 'product.create', productId: product.id, after: product },
      'audit',
    );
    res.status(201).json({ product });
  });

  r.patch('/products/:id', async (req, res) => {
    const { id } = parse(idParam, req.params);
    const input = parse(updateProductBody, req.body);
    const { before, after } = await d.products.update(id, input);
    const action =
      input.active === false
        ? 'product.deactivate'
        : input.active === true
          ? 'product.activate'
          : 'product.update';
    res.locals.log.info({ event: 'audit', action, productId: id, before, after }, 'audit');
    res.json({ product: after });
  });

  r.patch('/products/:id/stock', async (req, res) => {
    const { id } = parse(idParam, req.params);
    const input = parse(stockBody, req.body);
    const { before, after } = await d.products.changeStock(id, input);
    res.locals.log.info(
      {
        event: 'audit',
        action: 'stock.change',
        productId: id,
        mode: input.mode,
        value: input.value,
        before,
        after,
      },
      'audit',
    );
    res.json({ productId: id, stock: after });
  });

  r.get('/orders', async (req, res) => {
    const query = parse(adminOrdersQuery, req.query);
    res.json({ orders: await d.orders.listForAdmin(query) });
  });

  r.patch('/orders/:id/status', async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const { status } = parse(orderStatusBody, req.body);
    const change = await d.orders.changeStatus(id, status);
    res.locals.log.info(
      { event: 'audit', action: 'order.status', orderId: id, ...change },
      'audit',
    );
    res.json({ orderId: id, status: change.after });
  });

  return r;
}
