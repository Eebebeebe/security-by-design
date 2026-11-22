import type { Pool } from '../db/pool.js';
import { withTransaction } from '../db/pool.js';
import { AppError, ConflictError, NotFoundError, OutOfStockError } from '../errors.js';
import type { CreateOrderInput, OrderStatus } from '../schemas/index.js';
import { randomToken, safeEqualHex, sha256Hex } from './crypto.js';

export interface OrderItem {
  productId: number;
  name: string;
  quantity: number;
  unitPriceCents: number;
}

export interface OrderSummary {
  id: string;
  status: OrderStatus;
  totalCents: number;
  createdAt: Date;
  items: OrderItem[];
}

export interface AdminOrder extends OrderSummary {
  customerName: string;
  street: string;
  zip: string;
  city: string;
  phone: string;
}

/**
 * Erlaubte Statusübergänge (Zustandsautomat). Alles andere wird abgelehnt –
 * z.B. kann eine gelieferte Bestellung nicht mehr storniert werden.
 */
export const ORDER_TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  received: ['baking', 'cancelled'],
  baking: ['delivering', 'cancelled'],
  delivering: ['delivered'],
  delivered: [],
  cancelled: [],
};

export class OrderService {
  constructor(private readonly pool: Pool) {}

  /**
   * Legt eine Bestellung an. Sicherheitsrelevante Punkte:
   *  - Preise stammen AUSSCHLIESSLICH aus der DB, nie vom Client
   *  - SELECT ... FOR UPDATE sperrt die Produktzeilen -> kein Überverkauf bei parallelen Bestellungen
   *  - alles in einer Transaktion: entweder komplette Bestellung + Bestandsabzug oder gar nichts
   */
  async create(input: CreateOrderInput): Promise<{ order: OrderSummary; trackingToken: string }> {
    const ids = input.items.map((i) => i.productId);
    return withTransaction(this.pool, async (client) => {
      const { rows: products } = await client.query<{
        id: number;
        name: string;
        price_cents: number;
        stock: number;
        active: boolean;
      }>(
        'SELECT id, name, price_cents, stock, active FROM products WHERE id = ANY($1::int[]) ORDER BY id FOR UPDATE',
        [ids],
      );
      const byId = new Map(products.map((p) => [p.id, p]));

      const unavailable = ids.filter((id) => !byId.get(id)?.active);
      if (unavailable.length) {
        throw new AppError(
          400,
          'PRODUCT_UNAVAILABLE',
          'Mindestens ein Produkt ist nicht verfügbar.',
          {
            productIds: unavailable,
          },
        );
      }
      const insufficient = input.items
        .filter((i) => (byId.get(i.productId)?.stock ?? 0) < i.quantity)
        .map((i) => i.productId);
      if (insufficient.length) throw new OutOfStockError(insufficient);

      const items: OrderItem[] = input.items.map((i) => {
        const p = byId.get(i.productId);
        if (!p) throw new Error('unreachable: product vanished inside transaction');
        return {
          productId: p.id,
          name: p.name,
          quantity: i.quantity,
          unitPriceCents: p.price_cents,
        };
      });
      const totalCents = items.reduce((sum, i) => sum + i.quantity * i.unitPriceCents, 0);

      const trackingToken = randomToken();
      const c = input.customer;
      const { rows } = await client.query<{ id: string; status: OrderStatus; created_at: Date }>(
        `INSERT INTO orders (tracking_token_hash, customer_name, street, zip, city, phone, total_cents)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, status, created_at`,
        [sha256Hex(trackingToken), c.name, c.street, c.zip, c.city, c.phone, totalCents],
      );
      const order = rows[0];
      if (!order) throw new Error('INSERT returned no row');

      for (const item of items) {
        await client.query(
          'INSERT INTO order_items (order_id, product_id, quantity, unit_price_cents) VALUES ($1, $2, $3, $4)',
          [order.id, item.productId, item.quantity, item.unitPriceCents],
        );
        await client.query(
          'UPDATE products SET stock = stock - $2, updated_at = now() WHERE id = $1',
          [item.productId, item.quantity],
        );
      }
      return {
        order: {
          id: order.id,
          status: order.status,
          totalCents,
          createdAt: order.created_at,
          items,
        },
        trackingToken,
      };
    });
  }

  /**
   * Bestellstatus für Kunden. Ohne passendes Token gibt es dieselbe 404 wie für
   * eine nicht existierende Bestellung -> keine Aussage, ob die ID existiert (IDOR-Schutz).
   */
  async getForCustomer(id: string, token: string): Promise<OrderSummary> {
    const { rows } = await this.pool.query<{
      id: string;
      status: OrderStatus;
      total_cents: number;
      created_at: Date;
      tracking_token_hash: string;
    }>(
      'SELECT id, status, total_cents, created_at, tracking_token_hash FROM orders WHERE id = $1',
      [id],
    );
    const row = rows[0];
    if (!row || !safeEqualHex(row.tracking_token_hash, sha256Hex(token))) {
      throw new NotFoundError('Bestellung');
    }
    return {
      id: row.id,
      status: row.status,
      totalCents: row.total_cents,
      createdAt: row.created_at,
      items: await this.items(id),
    };
  }

  async listForAdmin(filter: {
    status?: OrderStatus | undefined;
    limit: number;
  }): Promise<AdminOrder[]> {
    const { rows } = await this.pool.query<Omit<AdminOrder, 'items'>>(
      `SELECT id, status, total_cents AS "totalCents", created_at AS "createdAt",
              customer_name AS "customerName", street, zip, city, phone
         FROM orders
        WHERE ($1::text IS NULL OR status = $1)
        ORDER BY created_at DESC
        LIMIT $2`,
      [filter.status ?? null, filter.limit],
    );
    const result: AdminOrder[] = [];
    for (const row of rows) result.push({ ...row, items: await this.items(row.id) });
    return result;
  }

  /** Statuswechsel nach Zustandsautomat; Stornierung bucht den Bestand zurück. */
  async changeStatus(
    id: string,
    next: OrderStatus,
  ): Promise<{ before: OrderStatus; after: OrderStatus }> {
    return withTransaction(this.pool, async (client) => {
      const { rows } = await client.query<{ status: OrderStatus }>(
        'SELECT status FROM orders WHERE id = $1 FOR UPDATE',
        [id],
      );
      const current = rows[0]?.status;
      if (!current) throw new NotFoundError('Bestellung');
      if (!ORDER_TRANSITIONS[current].includes(next)) {
        throw new ConflictError(
          'INVALID_TRANSITION',
          `Statuswechsel ${current} -> ${next} ist nicht erlaubt.`,
        );
      }
      if (next === 'cancelled') {
        await client.query(
          `UPDATE products p SET stock = LEAST(p.stock + oi.quantity, 100000), updated_at = now()
             FROM order_items oi WHERE oi.order_id = $1 AND oi.product_id = p.id`,
          [id],
        );
      }
      await client.query('UPDATE orders SET status = $2, updated_at = now() WHERE id = $1', [
        id,
        next,
      ]);
      return { before: current, after: next };
    });
  }

  private async items(orderId: string): Promise<OrderItem[]> {
    const { rows } = await this.pool.query<OrderItem>(
      `SELECT oi.product_id AS "productId", p.name, oi.quantity, oi.unit_price_cents AS "unitPriceCents"
         FROM order_items oi JOIN products p ON p.id = oi.product_id
        WHERE oi.order_id = $1 ORDER BY p.name`,
      [orderId],
    );
    return rows;
  }
}
