/**
 * Datenbank-Attrappe für Unit-Tests der Services.
 * Zeichnet jede Query (normalisiertes SQL + Parameter) auf und antwortet über eine Funktion.
 * So lässt sich prüfen, WELCHES SQL mit WELCHEN Parametern abgesetzt wird – ohne echte Postgres.
 */
import { vi } from 'vitest';
import type { Pool } from '../../src/db/pool.js';

export interface QueryResult {
  rows?: unknown[];
  rowCount?: number;
}
export type Responder = (
  sql: string,
  params: unknown[],
) => QueryResult | Error | undefined | Promise<QueryResult>;

export interface Call {
  sql: string;
  params: unknown[];
}

export function fakePool(respond: Responder = () => undefined) {
  const calls: Call[] = [];
  const run = async (sql: string, params: unknown[] = []) => {
    const normalized = sql.replace(/\s+/g, ' ').trim();
    calls.push({ sql: normalized, params });
    const result = await respond(normalized, params);
    if (result instanceof Error) throw result;
    const rows = result?.rows ?? [];
    return { rows, rowCount: result?.rowCount ?? rows.length };
  };
  const client = { query: vi.fn(run), release: vi.fn() };
  const pool = { query: vi.fn(run), connect: vi.fn(() => Promise.resolve(client)) };
  return {
    pool: pool as unknown as Pool,
    client,
    calls,
    sqls: () => calls.map((c) => c.sql),
    find: (pattern: RegExp) => calls.filter((c) => pattern.test(c.sql)),
  };
}

/** Postgres-Fehler mit SQLSTATE-Code (z.B. 23505 = unique_violation). */
export function pgError(code: string): Error {
  return Object.assign(new Error(`pg error ${code}`), { code });
}
