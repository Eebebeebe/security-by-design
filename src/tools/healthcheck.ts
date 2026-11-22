/**
 * Health-Check-Tool: gibt HEALTHY oder UNHEALTHY (+ Grund) aus, Exit-Code 0 bzw. 1.
 * Wird vom Docker-HEALTHCHECK genutzt (im Image gibt es kein curl) und ist auch manuell nutzbar:
 *   npm run healthcheck                       (lokal)
 *   docker compose exec app node dist/tools/healthcheck.js
 *   HEALTHCHECK_URL=http://host:3000 npm run healthcheck
 */
const base = (
  process.env.HEALTHCHECK_URL ?? `http://127.0.0.1:${process.env.PORT ?? '3000'}`
).replace(/\/$/, '');
const TIMEOUT_MS = 4_000;

interface Report {
  status?: string;
  checks?: Record<string, string>;
}

async function main(): Promise<number> {
  let res: Response;
  try {
    res = await fetch(`${base}/readyz`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.log(`UNHEALTHY: Anwendung unter ${base} nicht erreichbar (${reason})`);
    return 1;
  }
  let body: Report = {};
  try {
    body = (await res.json()) as Report;
  } catch {
    // Antwort ist kein JSON -> unten als ungesund gewertet
  }
  if (res.status === 200 && body.status === 'healthy') {
    console.log(`HEALTHY: ${JSON.stringify(body.checks ?? {})}`);
    return 0;
  }
  const failed = Object.entries(body.checks ?? {})
    .filter(([, v]) => v !== 'up' && v !== 'ok')
    .map(([k, v]) => `${k}=${v}`);
  console.log(
    `UNHEALTHY: HTTP ${res.status}${failed.length ? `, fehlgeschlagen: ${failed.join(', ')}` : ''}`,
  );
  return 1;
}

process.exitCode = await main();
