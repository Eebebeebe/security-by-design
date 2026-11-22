import { withTransaction, type Pool } from '../db/pool.js';
import { ConflictError, NotFoundError } from '../errors.js';
import type { CreateProductInput, StockInput, UpdateProductInput } from '../schemas/index.js';

export interface Product {
  id: number;
  name: string;
  description: string;
  category: 'pizza' | 'drink' | 'dessert';
  priceCents: number;
  stock: number;
  active: boolean;
}

const COLUMNS = `id, name, description, category, price_cents AS "priceCents", stock, active`;

/** Escaped % _ \ für LIKE, damit Suchbegriffe wörtlich gemeint sind. */
function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (c) => `\\${c}`);
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && err.code === '23505';
}

export class ProductService {
  constructor(private readonly pool: Pool) {}

  /** Öffentliche Sicht: nur aktive Produkte mit Bestand. */
  async listPublic(filter: {
    category?: string | undefined;
    q?: string | undefined;
  }): Promise<Product[]> {
    const { rows } = await this.pool.query<Product>(
      `SELECT ${COLUMNS} FROM products
        WHERE active AND stock > 0
          AND ($1::text IS NULL OR category = $1)
          AND ($2::text IS NULL OR name ILIKE '%' || $2 || '%' ESCAPE '\\')
        ORDER BY array_position(ARRAY['pizza','drink','dessert'], category), name`,
      [filter.category ?? null, filter.q ? escapeLike(filter.q) : null],
    );
    return rows;
  }

  async getPublic(id: number): Promise<Product> {
    const { rows } = await this.pool.query<Product>(
      `SELECT ${COLUMNS} FROM products WHERE id = $1 AND active`,
      [id],
    );
    if (!rows[0]) throw new NotFoundError('Produkt');
    return rows[0];
  }

  async listAll(): Promise<Product[]> {
    const { rows } = await this.pool.query<Product>(`SELECT ${COLUMNS} FROM products ORDER BY id`);
    return rows;
  }

  async get(id: number): Promise<Product> {
    const { rows } = await this.pool.query<Product>(
      `SELECT ${COLUMNS} FROM products WHERE id = $1`,
      [id],
    );
    if (!rows[0]) throw new NotFoundError('Produkt');
    return rows[0];
  }

  async create(input: CreateProductInput): Promise<Product> {
    try {
      const { rows } = await this.pool.query<Product>(
        `INSERT INTO products (name, description, category, price_cents, stock, active)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING ${COLUMNS}`,
        [
          input.name,
          input.description,
          input.category,
          input.priceCents,
          input.stock,
          input.active,
        ],
      );
      return rows[0] as Product;
    } catch (err) {
      if (isUniqueViolation(err))
        throw new ConflictError('DUPLICATE_NAME', 'Produktname existiert bereits.');
      throw err;
    }
  }

  /**
   * Teil-Update. Die Spaltennamen kommen aus einer festen Zuordnung (nie aus der Eingabe),
   * die Werte ausschließlich als Parameter -> keine SQL-Injection möglich.
   */
  async update(
    id: number,
    input: UpdateProductInput,
  ): Promise<{ before: Product; after: Product }> {
    const columnFor = {
      name: 'name',
      description: 'description',
      category: 'category',
      priceCents: 'price_cents',
      active: 'active',
    } as const;
    const sets: string[] = [];
    const values: unknown[] = [];
    for (const key of Object.keys(columnFor) as (keyof typeof columnFor)[]) {
      const value = input[key];
      if (value !== undefined) {
        values.push(value);
        sets.push(`${columnFor[key]} = $${values.length}`);
      }
    }
    const before = await this.get(id);
    values.push(id);
    try {
      const { rows } = await this.pool.query<Product>(
        `UPDATE products SET ${sets.join(', ')}, updated_at = now()
          WHERE id = $${values.length} RETURNING ${COLUMNS}`,
        values,
      );
      if (!rows[0]) throw new NotFoundError('Produkt');
      return { before, after: rows[0] };
    } catch (err) {
      if (isUniqueViolation(err))
        throw new ConflictError('DUPLICATE_NAME', 'Produktname existiert bereits.');
      throw err;
    }
  }

  /** Bestand setzen oder relativ anpassen – atomar in einem Statement, nie unter 0. */
  async changeStock(id: number, input: StockInput): Promise<{ before: number; after: number }> {
    return withTransaction(this.pool, async (client) => {
      // Zeile sperren: parallele Bestellungen/Admin-Änderungen warten -> kein Lost Update.
      const { rows } = await client.query<{ stock: number }>(
        'SELECT stock FROM products WHERE id = $1 FOR UPDATE',
        [id],
      );
      if (!rows[0]) throw new NotFoundError('Produkt');
      const before = rows[0].stock;
      const after = input.mode === 'set' ? input.value : before + input.value;
      if (after < 0 || after > 100_000) {
        throw new ConflictError(
          'STOCK_OUT_OF_RANGE',
          'Bestand muss zwischen 0 und 100000 liegen.',
          {
            current: before,
          },
        );
      }
      await client.query('UPDATE products SET stock = $2, updated_at = now() WHERE id = $1', [
        id,
        after,
      ]);
      return { before, after };
    });
  }
}
