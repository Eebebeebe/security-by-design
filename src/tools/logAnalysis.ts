/**
 * Reine Auswertelogik für die JSON-Logs der Anwendung (testbar ohne Dateisystem).
 *
 * Verfügbarkeit: Die App schreibt alle `intervalMs` ein "health.heartbeat"-Event mit status
 * healthy/unhealthy. Jeder Heartbeat "deckt" die Zeit bis zum nächsten ab. Ist die Lücke
 * größer als 2 Intervalle (Prozess war weg / hing), zählt alles nach dem ersten Intervall als Ausfall.
 */
export interface LogEntry {
  time?: string;
  level?: string;
  levelValue?: number;
  event?: string;
  msg?: string;
  status?: number | string;
  intervalMs?: number;
}

export interface AnalysisOptions {
  since?: Date | undefined;
  defaultIntervalMs?: number;
}

export interface AnalysisReport {
  window: { from: string | null; to: string | null; durationSec: number };
  lines: { total: number; parsed: number; unparsed: number };
  availability: {
    heartbeats: number;
    healthyHeartbeats: number;
    unhealthyHeartbeats: number;
    gaps: number;
    uptimeSec: number;
    downtimeSec: number;
    availabilityPct: number | null;
    restarts: number;
  };
  requests: {
    total: number;
    status2xx: number;
    status4xx: number;
    status5xx: number;
    errorRatePct: number | null;
  };
  errors: { count: number; ratePct: number | null; top: { key: string; count: number }[] };
}

function isError(e: LogEntry): boolean {
  return (e.levelValue ?? 0) >= 50 || e.level === 'error' || e.level === 'fatal';
}

const pct = (part: number, total: number): number | null =>
  total === 0 ? null : Math.round((part / total) * 10_000) / 100;

export function analyze(rawLines: Iterable<string>, opts: AnalysisOptions = {}): AnalysisReport {
  const defaultInterval = opts.defaultIntervalMs ?? 30_000;
  const entries: (LogEntry & { t: number })[] = [];
  let total = 0;
  let unparsed = 0;

  for (const line of rawLines) {
    if (!line.trim()) continue;
    total++;
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      unparsed++;
      continue;
    }
    if (typeof obj !== 'object' || obj === null) {
      unparsed++;
      continue;
    }
    const e = obj as LogEntry;
    const t = e.time ? Date.parse(e.time) : NaN;
    if (Number.isNaN(t)) {
      unparsed++;
      continue;
    }
    if (opts.since && t < opts.since.getTime()) continue;
    entries.push({ ...e, t });
  }
  entries.sort((a, b) => a.t - b.t);

  // --- Verfügbarkeit aus Heartbeats ---
  const beats = entries.filter((e) => e.event === 'health.heartbeat');
  let up = 0;
  let down = 0;
  let gaps = 0;
  let healthy = 0;
  beats.forEach((b, i) => {
    const interval = b.intervalMs ?? defaultInterval;
    const next = beats[i + 1];
    const span = next ? next.t - b.t : interval;
    const isHealthy = b.status === 'healthy';
    if (isHealthy) healthy++;
    let covered = span;
    if (span > 2 * interval) {
      gaps++;
      covered = interval;
      down += span - interval;
    }
    if (isHealthy) up += covered;
    else down += covered;
  });

  // --- Requests & Fehler ---
  const requests = entries.filter((e) => e.event === 'http.request');
  const statusOf = (e: LogEntry) => Number(e.status);
  const s5 = requests.filter((r) => statusOf(r) >= 500).length;
  const s4 = requests.filter((r) => statusOf(r) >= 400 && statusOf(r) < 500).length;

  const errors = entries.filter(isError);
  const counts = new Map<string, number>();
  for (const e of errors) {
    const key = e.event ?? e.msg ?? '(ohne event)';
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const top = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([key, count]) => ({ key, count }));

  const first = entries[0];
  const last = entries[entries.length - 1];
  return {
    window: {
      from: first ? new Date(first.t).toISOString() : null,
      to: last ? new Date(last.t).toISOString() : null,
      durationSec: first && last ? Math.round((last.t - first.t) / 1000) : 0,
    },
    lines: { total, parsed: total - unparsed, unparsed },
    availability: {
      heartbeats: beats.length,
      healthyHeartbeats: healthy,
      unhealthyHeartbeats: beats.length - healthy,
      gaps,
      uptimeSec: Math.round(up / 1000),
      downtimeSec: Math.round(down / 1000),
      availabilityPct: pct(up, up + down),
      restarts: Math.max(0, entries.filter((e) => e.event === 'app.started').length - 1),
    },
    requests: {
      total: requests.length,
      status2xx: requests.filter((r) => statusOf(r) >= 200 && statusOf(r) < 300).length,
      status4xx: s4,
      status5xx: s5,
      errorRatePct: pct(s5, requests.length),
    },
    errors: { count: errors.length, ratePct: pct(errors.length, entries.length), top },
  };
}

export function toMarkdown(r: AnalysisReport): string {
  const a = r.availability;
  const fmt = (v: number | null) => (v === null ? 'n/a' : `${v} %`);
  return [
    '# Log-Auswertung',
    '',
    `Zeitraum: ${r.window.from ?? '-'} bis ${r.window.to ?? '-'} (${r.window.durationSec} s)`,
    `Zeilen: ${r.lines.total} (davon nicht auswertbar: ${r.lines.unparsed})`,
    '',
    '## Verfügbarkeit',
    '',
    '| Kennzahl | Wert |',
    '|---|---|',
    `| Verfügbarkeit | **${fmt(a.availabilityPct)}** |`,
    `| Uptime / Downtime | ${a.uptimeSec} s / ${a.downtimeSec} s |`,
    `| Heartbeats (healthy / unhealthy) | ${a.heartbeats} (${a.healthyHeartbeats} / ${a.unhealthyHeartbeats}) |`,
    `| Heartbeat-Lücken (Prozess weg) | ${a.gaps} |`,
    `| Neustarts | ${a.restarts} |`,
    '',
    '## Requests & Fehler',
    '',
    '| Kennzahl | Wert |',
    '|---|---|',
    `| Requests gesamt | ${r.requests.total} |`,
    `| 2xx / 4xx / 5xx | ${r.requests.status2xx} / ${r.requests.status4xx} / ${r.requests.status5xx} |`,
    `| 5xx-Quote | **${fmt(r.requests.errorRatePct)}** |`,
    `| Error-Events (level >= error) | ${r.errors.count} (${fmt(r.errors.ratePct)} aller Events) |`,
    '',
    ...(r.errors.top.length
      ? ['Häufigste Error-Events:', '', ...r.errors.top.map((t) => `- \`${t.key}\`: ${t.count}`)]
      : ['Keine Error-Events.']),
    '',
  ].join('\n');
}
