import { pino } from 'pino';
import { vi } from 'vitest';
import { createApp } from '../src/app.js';
import { loadConfig, type Config } from '../src/config.js';
import { listMigrations, migrate } from '../src/db/migrate.js';
import { createPool, type Pool } from '../src/db/pool.js';
import { HealthService } from '../src/health.js';

export const ADMIN_PASSWORD = 'test-admin-password-123';

export function testConfig(overrides: Record<string, string> = {}): Config {
  return loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: process.env.DATABASE_URL ?? 'postgres://unused@localhost/unused',
    DB_POOL_MAX: process.env.DB_POOL_MAX ?? '2',
    ADMIN_USERNAME: 'admin',
    ADMIN_PASSWORD,
    COOKIE_SECURE: 'false',
    LOG_LEVEL: 'silent',
    LOGIN_RATE_LIMIT: '1000',
    ...overrides,
  });
}

export const silentLog = pino({ level: 'silent' });

/** Pool-Attrappe, die bei JEDEM Zugriff fehlschlägt -> beweist, dass Validierung vor der DB greift. */
export function explodingPool() {
  const query = vi.fn(() => {
    throw new Error('DB darf nicht erreicht werden');
  });
  const connect = vi.fn(() => {
    throw new Error('DB darf nicht erreicht werden');
  });
  return { pool: { query, connect } as unknown as Pool, query, connect };
}

export function appWithoutDb(overrides: Record<string, string> = {}) {
  const fake = explodingPool();
  const { app } = createApp({
    config: testConfig(overrides),
    pool: fake.pool,
    log: silentLog,
    health: new HealthService(fake.pool, 2),
  });
  return { app, ...fake };
}

// ---------------- Integration (echte Postgres) ----------------

export function requireDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      'Integrationstests brauchen DATABASE_URL (z.B. docker compose up -d db). Nur Unit-Tests: npm run test:unit',
    );
  }
  return url;
}

export interface TestDb {
  pool: Pool;
  products: { margherita: number; salami: number; cola: number; inactive: number; soldOut: number };
}

export async function setupDb(): Promise<Pool> {
  const pool = createPool(requireDatabaseUrl(), Number(process.env.DB_POOL_MAX ?? '2'));
  await migrate(pool);
  return pool;
}

/** Setzt die Datenbank auf einen bekannten Zustand zurück. */
export async function resetDb(pool: Pool): Promise<TestDb['products']> {
  await pool.query(
    'TRUNCATE order_items, orders, admin_sessions, admin_users, products RESTART IDENTITY CASCADE',
  );
  const { rows } = await pool.query<{ id: number; name: string }>(
    `INSERT INTO products (name, description, category, price_cents, stock, active) VALUES
       ('Margherita', 'Klassiker', 'pizza', 890, 10, true),
       ('Salami', 'Mit Salami', 'pizza', 990, 2, true),
       ('Cola', 'Gekühlt', 'drink', 250, 50, true),
       ('Alte Pizza', 'Nicht mehr im Sortiment', 'pizza', 700, 5, false),
       ('Ausverkauft', 'Bestand 0', 'pizza', 800, 0, true)
     RETURNING id, name`,
  );
  const id = (name: string) => {
    const row = rows.find((r) => r.name === name);
    if (!row) throw new Error(`seed missing ${name}`);
    return row.id;
  };
  return {
    margherita: id('Margherita'),
    salami: id('Salami'),
    cola: id('Cola'),
    inactive: id('Alte Pizza'),
    soldOut: id('Ausverkauft'),
  };
}

export async function appWithDb(pool: Pool, overrides: Record<string, string> = {}) {
  const config = testConfig(overrides);
  const health = new HealthService(pool, (await listMigrations()).length);
  const { app, auth } = createApp({ config, pool, log: silentLog, health });
  await auth.ensureAdmin(config.ADMIN_USERNAME, config.ADMIN_PASSWORD);
  return app;
}

export const validCustomer = {
  name: 'Max Mustermann',
  street: 'Hauptstraße 1',
  zip: '12345',
  city: 'Berlin',
  phone: '+49 30 123456',
};
