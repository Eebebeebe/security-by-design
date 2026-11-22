import { Router } from 'express';
import type { Logger } from 'pino';
import type { Pool } from './db/pool.js';

export interface HealthReport {
  status: 'healthy' | 'unhealthy';
  checks: { database: 'up' | 'down'; migrations: 'ok' | 'pending' | 'unknown' };
  uptimeSec: number;
}

const startedAt = Date.now();

/**
 * Prüft, ob die Anwendung wirklich arbeitsfähig ist – nicht nur, ob der Prozess lebt:
 *  - Datenbank antwortet (mit Timeout, damit der Check selbst nicht hängt)
 *  - alle Migrationen sind angewendet (Schema passt zum Code)
 */
export class HealthService {
  constructor(
    private readonly pool: Pool,
    private readonly expectedMigrations: number,
  ) {}

  async check(): Promise<HealthReport> {
    let database: 'up' | 'down';
    let migrations: HealthReport['checks']['migrations'] = 'unknown';
    try {
      await withTimeout(this.pool.query('SELECT 1'), 2_000);
      database = 'up';
    } catch {
      database = 'down';
    }
    if (database === 'up') {
      try {
        const { rows } = await withTimeout(
          this.pool.query<{ n: number }>('SELECT count(*)::int AS n FROM schema_migrations'),
          2_000,
        );
        migrations = (rows[0]?.n ?? 0) >= this.expectedMigrations ? 'ok' : 'pending';
      } catch {
        migrations = 'pending'; // DB erreichbar, aber Schema-Tabelle fehlt
      }
    }
    const status = database === 'up' && migrations === 'ok' ? 'healthy' : 'unhealthy';
    return {
      status,
      checks: { database, migrations },
      uptimeSec: Math.round((Date.now() - startedAt) / 1000),
    };
  }

  /**
   * Schreibt regelmäßig ein "health.heartbeat"-Event ins Log.
   * Daraus berechnet src/tools/analyze-logs.ts Uptime/Verfügbarkeit – auch ohne externes Monitoring.
   */
  startHeartbeat(log: Logger, intervalMs: number): () => void {
    const beat = async () => {
      const report = await this.check();
      const entry = { event: 'health.heartbeat', ...report, intervalMs };
      if (report.status === 'healthy') log.info(entry, 'heartbeat');
      else log.error(entry, 'heartbeat: unhealthy');
    };
    void beat();
    const timer = setInterval(() => void beat(), intervalMs);
    timer.unref();
    return () => {
      clearInterval(timer);
    };
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      reject(new Error(`timeout after ${ms}ms`));
    }, ms);
    promise.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(t);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

/** /healthz = Liveness (Prozess lebt), /readyz = Readiness (DB + Schema ok). */
export function healthRouter(health: HealthService): Router {
  const r = Router();
  r.get('/healthz', (_req, res) => {
    res.json({ status: 'alive' });
  });
  r.get('/readyz', async (_req, res) => {
    const report = await health.check();
    res.status(report.status === 'healthy' ? 200 : 503).json(report);
  });
  return r;
}
