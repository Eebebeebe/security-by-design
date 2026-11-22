import { z } from 'zod';

/**
 * Zentrale, validierte Konfiguration (Fail Fast).
 * Fehlt etwas oder ist es unsicher, startet die Anwendung gar nicht erst –
 * statt später mit einem unsicheren Default zu laufen.
 */
const booleanFromEnv = z.enum(['true', 'false']).transform((v) => v === 'true');

const WEAK_PASSWORDS = new Set(['admin', 'password', 'changeme', 'change-me', '123456789012']);

export const configSchema = z.object({
  NODE_ENV: z.enum(['production', 'development', 'test']).default('production'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_URL: z
    .string()
    .regex(/^postgres(ql)?:\/\//, 'DATABASE_URL muss eine postgres:// URL sein'),
  DB_POOL_MAX: z.coerce.number().int().min(1).max(50).default(10),
  ADMIN_USERNAME: z
    .string()
    .regex(/^[a-zA-Z0-9_.-]{3,40}$/, 'ADMIN_USERNAME: 3-40 Zeichen [a-zA-Z0-9_.-]')
    .default('admin'),
  ADMIN_PASSWORD: z
    .string({ error: 'ADMIN_PASSWORD ist Pflicht' })
    .min(12, 'ADMIN_PASSWORD muss mindestens 12 Zeichen lang sein')
    .max(200)
    .refine((pw) => !WEAK_PASSWORDS.has(pw.toLowerCase()), 'ADMIN_PASSWORD ist zu schwach'),
  SESSION_TTL_MINUTES: z.coerce
    .number()
    .int()
    .min(5)
    .max(24 * 60)
    .default(60),
  // Sicherer Default: Cookies nur über HTTPS. Muss für lokales HTTP bewusst abgeschaltet werden.
  COOKIE_SECURE: booleanFromEnv.default(true),
  TRUST_PROXY: booleanFromEnv.default(false),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  LOG_FILE: z.string().min(1).optional(),
  HEARTBEAT_INTERVAL_MS: z.coerce.number().int().min(1000).max(600_000).default(30_000),
  LOGIN_RATE_LIMIT: z.coerce.number().int().min(1).max(1000).default(10),
});

export type Config = z.infer<typeof configSchema>;

export class ConfigError extends Error {
  constructor(public readonly problems: string[]) {
    super(`Ungültige Konfiguration:\n - ${problems.join('\n - ')}`);
    this.name = 'ConfigError';
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // Leere Strings wie "nicht gesetzt" behandeln, damit Defaults greifen.
  const cleaned = Object.fromEntries(
    Object.entries(env).filter(([, v]) => v !== undefined && v !== ''),
  );
  const result = configSchema.safeParse(cleaned);
  if (!result.success) {
    // Nur Feldname + Problem ausgeben, niemals den (evtl. geheimen) Wert.
    throw new ConfigError(
      result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
    );
  }
  return result.data;
}
