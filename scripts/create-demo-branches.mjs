#!/usr/bin/env node
// Erzeugt Demo-Branches mit ABSICHTLICH fehlerhaftem/unsicherem Code für die Positivtests.
// Jeder Branch muss in der CI rot werden. Diese Branches werden NIE nach main gemerged.
//
//   node scripts/create-demo-branches.mjs          -> legt alle Branches lokal an (ab aktuellem HEAD)
//   git push origin --all                           -> CI läuft auf jedem Branch
//
// Voraussetzung: sauberer Working Tree.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const npm = (...args) =>
  execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, {
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });

function replaceIn(file, search, replacement) {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- feste Dateien dieses Repos
  const text = readFileSync(file, 'utf8');
  if (!text.includes(search))
    throw new Error(`${file}: Suchtext nicht gefunden – Skript an Code anpassen`);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- feste Dateien dieses Repos
  writeFileSync(file, text.replace(search, replacement));
}

const demos = [
  {
    branch: 'demo/sast-sqli',
    expect:
      'Security / SAST (Semgrep) schlägt fehl: pizza-sql-string-concat + nodejsscan SQLi-Regel',
    apply() {
      replaceIn(
        'src/services/productService.ts',
        '  async getPublic(id: number): Promise<Product> {',
        `  // DEMO: absichtlich unsicher – SQL per String-Verkettung
  async searchUnsafe(term: string): Promise<Product[]> {
    const { rows } = await this.pool.query<Product>(
      "SELECT * FROM products WHERE name = '" + term + "'",
    );
    return rows;
  }

  async getPublic(id: number): Promise<Product> {`,
      );
    },
  },
  {
    branch: 'demo/secret-leak',
    expect: 'Security / Secret Scanning (gitleaks) schlägt fehl: pizza-admin-password + github-pat',
    apply() {
      mkdirSync('deploy', { recursive: true });
      // Zufällig erzeugte, ungültige Werte im Format echter Secrets
      // Schlüsselnamen zusammengesetzt, damit dieses Skript selbst auf main nicht anschlägt.
      const pwKey = ['ADMIN', 'PASSWORD'].join('_');
      const fakePat = ['gh', 'p_'].join('') + randomBytes(27).toString('base64url').slice(0, 36);
      const fakePw = 'Pr0d-' + randomBytes(6).toString('hex') + '!';
      writeFileSync(
        'deploy/prod.env',
        `# DEMO: versehentlich eingecheckte Produktiv-Konfiguration\n${pwKey}=${fakePw}\nGITHUB_TOKEN=${fakePat}\n`,
      );
    },
  },
  {
    branch: 'demo/broken-stock',
    expect: 'CI / Anwendungstests schlagen fehl: Bestand wird nach Bestellung nicht reduziert',
    apply() {
      replaceIn(
        'src/services/orderService.ts',
        "'UPDATE products SET stock = stock - $2, updated_at = now() WHERE id = $1'",
        "'UPDATE products SET updated_at = now() WHERE id = $1 AND $2::int > 0'",
      );
    },
  },
  {
    branch: 'demo/xss-frontend',
    expect: 'CI / ESLint (no-restricted-properties) + Semgrep (pizza-dom-xss-sink) schlagen fehl',
    apply() {
      replaceIn(
        'public/shop.js',
        "        el('h3', {}, p.name),",
        "        Object.assign(document.createElement('h3'), { innerHTML: p.name }),",
      );
      replaceIn(
        'public/shop.js',
        "'use strict';",
        "'use strict';\n// DEMO: XSS-Senke\ndocument.getElementById('products').innerHTML = location.hash;",
      );
    },
  },
  {
    branch: 'demo/vulnerable-dependency',
    expect:
      'CI / npm audit schlägt fehl (lodash 4.17.20: Prototype Pollution / Command Injection, high)',
    apply() {
      npm('install', '--save-exact', '--ignore-scripts', '--no-audit', 'lodash@4.17.20');
    },
  },
];

if (git('status', '--porcelain')) {
  console.error('Working Tree ist nicht sauber. Bitte erst committen/stashen.');
  process.exit(1);
}
const base = git('rev-parse', '--abbrev-ref', 'HEAD');
for (const demo of demos) {
  console.log(`\n==> ${demo.branch}\n    Erwartung: ${demo.expect}`);
  git('switch', '-C', demo.branch, base);
  demo.apply();
  git('add', '-A');
  git('commit', '-m', `demo: Positivtest – ${demo.expect}`, '--no-verify');
  git('switch', base);
}
console.log(`\nFertig. Pushen mit:  git push -f origin ${demos.map((d) => d.branch).join(' ')}`);
