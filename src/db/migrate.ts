import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Logger } from 'pino';
import { createPool, withTransaction, type Pool } from './pool.js';

// Funktioniert aus src/db (tsx) und dist/db (kompiliert) gleichermaßen.
const MIGRATIONS_DIR = fileURLToPath(new URL('../../db/migrations/', import.meta.url));
const MIGRATION_FILE = /^\d{3}_[a-z0-9_]+\.sql$/;
const LOCK_ID = 727_001; // beliebige, feste Zahl für pg_advisory_xact_lock

export async function listMigrations(): Promise<string[]> {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- fester Pfad relativ zum Modul, keine Nutzereingabe
  const files = await readdir(MIGRATIONS_DIR);
  return files.filter((f) => MIGRATION_FILE.test(f)).sort();
}

/**
 * Wendet alle noch fehlenden Migrationen in EINER Transaktion an.
 * Der Advisory-Lock verhindert, dass zwei gleichzeitig startende Instanzen doppelt migrieren.
 */
export async function migrate(pool: Pool, log?: Logger): Promise<string[]> {
  const files = await listMigrations();
  return withTransaction(pool, async (client) => {
    await client.query('SELECT pg_advisory_xact_lock($1)', [LOCK_ID]);
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    const { rows } = await client.query<{ name: string }>('SELECT name FROM schema_migrations');
    const applied = new Set(rows.map((r) => r.name));
    const pending = files.filter((f) => !applied.has(f));
    for (const file of pending) {
      // Dateiname ist per Regex auf [0-9a-z_] beschränkt -> kein Path Traversal möglich.
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- siehe Kommentar oben
      const sql = await readFile(`${MIGRATIONS_DIR}/${file}`, 'utf8');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
      log?.info({ event: 'db.migration.applied', migration: file }, 'Migration angewendet');
    }
    return pending;
  });
}

// CLI: `npm run migrate` – braucht nur DATABASE_URL.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL fehlt');
    process.exit(1);
  }
  const pool = createPool(url, 1);
  migrate(pool)
    .then((applied) => {
      console.log(applied.length ? `Angewendet: ${applied.join(', ')}` : 'Schema ist aktuell.');
    })
    .catch((err: unknown) => {
      console.error('Migration fehlgeschlagen:', err instanceof Error ? err.message : err);
      process.exitCode = 1;
    })
    .finally(() => void pool.end());
}
