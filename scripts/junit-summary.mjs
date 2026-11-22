// Wandelt einen JUnit-XML-Bericht (vitest) in einen lesbaren Markdown-Testbericht um.
// Nutzung: node scripts/junit-summary.mjs test-results/junit.xml > docs/evidence/testing/testbericht.md
import { readFileSync } from 'node:fs';

const file = process.argv[2] ?? 'test-results/junit.xml';
let xml;
try {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- CLI-Argument des Entwicklers
  xml = readFileSync(file, 'utf8');
} catch {
  console.log(`> Kein Testbericht gefunden (${file}).`);
  process.exit(0);
}

// eslint-disable-next-line security/detect-non-literal-regexp -- name ist eine feste Konstante im Skript
const attr = (s, name) => (s.match(new RegExp(`${name}="([^"]*)"`)) ?? [])[1] ?? '';
const unescape = (s) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');

const suites = [...xml.matchAll(/<testsuite\b([^>]*)>([\s\S]*?)<\/testsuite>/g)];
let total = 0;
let failed = 0;
let skipped = 0;
const lines = [];
for (const [, head, body] of suites) {
  lines.push(
    `\n### ${unescape(attr(head, 'name'))}\n`,
    '| Ergebnis | Test | Dauer |',
    '|---|---|---|',
  );
  for (const [, caseHead, caseBody = ''] of body.matchAll(
    /<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g,
  )) {
    total++;
    const isFail = /<failure|<error/.test(caseBody);
    const isSkip = /<skipped/.test(caseBody);
    if (isFail) failed++;
    if (isSkip) skipped++;
    const icon = isFail ? '❌' : isSkip ? '⏭️' : '✅';
    const name = unescape(attr(caseHead, 'name')).replace(/\|/g, '\\|');
    lines.push(`| ${icon} | ${name} | ${Math.round(Number(attr(caseHead, 'time')) * 1000)} ms |`);
  }
}

console.log('## Testbericht');
console.log();
console.log(
  `**${total - failed - skipped} bestanden**, ${failed} fehlgeschlagen, ${skipped} übersprungen (gesamt ${total})`,
);
console.log(lines.join('\n'));
