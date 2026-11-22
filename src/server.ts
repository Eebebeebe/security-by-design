import type { Server } from 'node:http';
import { createApp } from './app.js';
import { ConfigError, loadConfig } from './config.js';
import { listMigrations, migrate } from './db/migrate.js';
import { createPool } from './db/pool.js';
import { HealthService } from './health.js';
import { createLogger } from './logger.js';

async function main(): Promise<void> {
  // 1) Konfiguration prüfen – bei Fehlern sofort abbrechen (Fail Fast).
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      // Logger existiert noch nicht -> minimal strukturiert selbst schreiben.
      process.stderr.write(
        JSON.stringify({
          level: 'fatal',
          event: 'app.config.invalid',
          problems: err.problems,
          time: new Date().toISOString(),
        }) + '\n',
      );
      process.exit(78); // EX_CONFIG
    }
    throw err;
  }

  const log = createLogger({ level: config.LOG_LEVEL, file: config.LOG_FILE });
  const pool = createPool(config.DATABASE_URL, config.DB_POOL_MAX);
  pool.on('error', (err) => {
    log.error({ event: 'db.pool.error', err }, 'idle client error');
  });

  // Letzte Verteidigungslinie: nichts darf unbemerkt untergehen.
  process.on('unhandledRejection', (reason) => {
    log.fatal({ event: 'app.crash', reason }, 'unhandled promise rejection');
    process.exit(1);
  });
  process.on('uncaughtException', (err) => {
    log.fatal({ event: 'app.crash', err }, 'uncaught exception');
    process.exit(1);
  });

  // 2) Schema aktualisieren, Admin anlegen.
  await migrate(pool, log);
  const health = new HealthService(pool, (await listMigrations()).length);
  const { app, auth } = createApp({ config, pool, log, health });
  await auth.ensureAdmin(config.ADMIN_USERNAME, config.ADMIN_PASSWORD);

  // 3) Starten.
  const server: Server = app.listen(config.PORT, () => {
    log.info(
      { event: 'app.started', port: config.PORT, nodeEnv: config.NODE_ENV, pid: process.pid },
      'server started',
    );
  });
  server.headersTimeout = 15_000;
  server.requestTimeout = 30_000;
  const stopHeartbeat = health.startHeartbeat(log, config.HEARTBEAT_INTERVAL_MS);

  // 4) Graceful Shutdown: laufende Requests fertig, dann DB schließen.
  let stopping = false;
  const shutdown = (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info({ event: 'app.stopping', signal }, 'shutting down');
    stopHeartbeat();
    const force = setTimeout(() => {
      log.error({ event: 'app.shutdown.forced' }, 'forced shutdown after timeout');
      process.exit(1);
    }, 10_000);
    force.unref();
    server.close(() => {
      void pool.end().finally(() => {
        log.info({ event: 'app.stopped' }, 'bye');
        process.exit(0);
      });
    });
  };
  process.on('SIGTERM', () => {
    shutdown('SIGTERM');
  });
  process.on('SIGINT', () => {
    shutdown('SIGINT');
  });
}

main().catch((err: unknown) => {
  process.stderr.write(
    JSON.stringify({
      level: 'fatal',
      event: 'app.startup.failed',
      message: err instanceof Error ? err.message : String(err),
      time: new Date().toISOString(),
    }) + '\n',
  );
  process.exit(1);
});
