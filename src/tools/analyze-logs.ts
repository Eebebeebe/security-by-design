/**
 * Wertet die JSON-Logs der Anwendung aus: Verfügbarkeit, 5xx-Quote, Anzahl/Quote der Error-Events.
 *
 * Nutzung:
 *   npm run analyze-logs -- logs/app.log
 *   docker compose logs app --no-log-prefix | npm run analyze-logs -- -
 *   node dist/tools/analyze-logs.js --format json --since 2026-01-01T00:00:00Z app.log
 *   ... --min-availability 99.5      -> Exit-Code 2, wenn Verfügbarkeit darunter liegt (für Alerting/CI)
 */
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import { analyze, toMarkdown } from './logAnalysis.js';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    format: { type: 'string', default: 'md' },
    since: { type: 'string' },
    'min-availability': { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  },
});

if (values.help) {
  console.log(
    'Usage: analyze-logs [--format md|json] [--since ISO-DATE] [--min-availability PCT] <file...|->',
  );
  process.exit(0);
}

async function readLines(sources: string[]): Promise<string[]> {
  const lines: string[] = [];
  for (const src of sources.length ? sources : ['-']) {
    const input =
      src === '-'
        ? process.stdin
        : // eslint-disable-next-line security/detect-non-literal-fs-filename -- Operator-CLI: Pfad kommt bewusst vom aufrufenden Admin, kein Netzwerk-Input
          createReadStream(src, { encoding: 'utf8' });
    for await (const line of createInterface({ input, crlfDelay: Infinity })) lines.push(line);
  }
  return lines;
}

const since = values.since ? new Date(values.since) : undefined;
if (since && Number.isNaN(since.getTime())) {
  console.error('--since: ungültiges Datum');
  process.exit(64);
}

const report = analyze(await readLines(positionals), { since });
console.log(values.format === 'json' ? JSON.stringify(report, null, 2) : toMarkdown(report));

const min = values['min-availability'];
if (min !== undefined) {
  const threshold = Number(min);
  const actual = report.availability.availabilityPct;
  if (actual === null || actual < threshold) {
    console.error(`ALERT: Verfügbarkeit ${actual ?? 'n/a'} % < Schwellwert ${threshold} %`);
    process.exitCode = 2;
  }
}
