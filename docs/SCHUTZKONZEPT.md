# Schutzkonzept – Pizzeria Sicher

> **Vertiefungen:** **2. Code Security** und **4. Logging & Betrieb**.
> Alle anderen Felder sind mindestens im geforderten Maß erfüllt (Feld 1 und 3 sogar vollständig).
> Nachweise liegen unter [`docs/evidence/`](evidence/README.md) bzw. in den GitHub-Actions-Läufen.

## 0. Überblick: Anwendung und Angriffsfläche

Ein Pizza-Webshop: Kunden bestellen ohne Konto, erhalten einen geheimen Tracking-Code und können den Status abfragen. Ein Admin pflegt Sortiment, Bestand und Bestellstatus. Technik: Node.js 24 / TypeScript / Express 5, PostgreSQL 17, Vanilla-JS-Frontend, ausgeliefert als ein Docker-Image. Details: [README](../README.md), Datenflüsse: [datenfluss.md](datenfluss.md).

| Angriffsfläche | Beispiel-Risiko | Wichtigste Maßnahme |
|---|---|---|
| Bestell-Endpoint (öffentlich, schreibt in DB) | SQL-Injection, Preismanipulation, Überverkauf, DoS durch große Bodies | strikte Validierung, Preise aus DB, Transaktion + Row-Locks, Body-Limit |
| Bestellstatus-Abfrage | IDOR (fremde Bestellungen lesen) | 256-Bit-Token, nur Hash gespeichert, einheitliche 404 |
| Admin-Login | Brute Force, User-Enumeration | scrypt, Rate-Limit, gleiche Antwort & Laufzeit |
| Admin-Aktionen | CSRF, Session-Diebstahl, Mass Assignment | SameSite=Strict + Origin-Check, HttpOnly-Cookie, `strictObject` |
| Frontend | XSS | kein `innerHTML` (ESLint + Semgrep), CSP ohne Inline-Skripte |
| Fehler/Logs | Informationsabfluss, Log-Injection | generische Fehler + requestId, Redaction, Steuerzeichen-Verbot |
| Lieferkette | kompromittierte Action/Image/Paket | SHA-/Digest-Pinning, Lockfile, Audit, Trivy, SBOM, Dependabot |

---

## 1. Building von Artefakten — Mindestmaß ✔ (beide Punkte + automatische Veröffentlichung)

| Kriterium | Umsetzung | Nachweis |
|---|---|---|
| 1.1 Build/Packaging dokumentiert | README → *Installation* (Varianten A–C) | [README.md](../README.md#installation) |
| 1.2 Build-Skript | `scripts/build.sh`: `npm ci` → Lint → Typcheck → Unit-Tests → `npm audit` → `docker build`, Tag = Git-SHA | [scripts/build.sh](../scripts/build.sh) |
| Zusätzlich: Auto-Publish | Merge auf `main` → [`release.yml`](../.github/workflows/release.yml) baut, scannt und pusht `ghcr.io/eebebeebe/pizza-shop:{sha,vX-build.N,latest}` + GitHub-Release; per `docker compose up` direkt installierbar | Actions → *Release*; Packages; Releases |

Artefakt: Multi-Stage-[Dockerfile](../Dockerfile) – Build-Stage mit Dev-Tools, Runtime-Stage nur mit `dist/`, Prod-Abhängigkeiten und Migrationen; läuft als `node` (non-root), Dateien gehören `root`, npm/npx entfernt, `HEALTHCHECK` eingebaut.

---

## 2. Code Security — **VERTIEFUNG** (alle drei Punkte)

### 2.1 Frühe Validierung (Fail Fast) + statische Typprüfung
- **Was:** Jede Eingabe wird als *erste* Aktion im Handler gegen ein zod-Schema geprüft ([`src/schemas/index.ts`](../src/schemas/index.ts)): `strictObject` (unbekannte Felder ⇒ Fehler, verhindert Mass Assignment wie `priceCents` im Bestellkörper), harte Längen/Wertebereiche, Regex ohne verschachtelte Quantoren, Verbot von Steuerzeichen. Ungültig ⇒ `400 VALIDATION_FAILED` **bevor** eine DB-Verbindung angefasst wird. Auch die Konfiguration wird beim Start validiert ([`src/config.ts`](../src/config.ts)) – fehlt ein starkes Admin-Passwort, startet der Prozess nicht (Exit 78).
- **Typen:** TypeScript `strict` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`; die zod-Schemas erzeugen die Typen der Service-Schicht (eine Quelle der Wahrheit). `tsc --noEmit` läuft im CI und im pre-commit Hook.
- **Positivtest:** [`tests/unit/failfast.test.ts`](../tests/unit/failfast.test.ts) – die App läuft mit einer Datenbank-Attrappe, die bei *jedem* Zugriff eine Exception wirft. 9 Angriffs-/Fehlerfälle (negative Menge, SQL im `productId`, Client-Preis, Steuerzeichen-Log-Injection, …) liefern `400` und die Attrappe wird **nie aufgerufen**. CI-Smoke-Test in [`ci.yml`](../.github/workflows/ci.yml): Container ohne `ADMIN_PASSWORD` ⇒ Exit-Code 78.

### 2.2 Sichere Defaults & explizite, sichere Fehlerbehandlung
| Default | Wo |
|---|---|
| Helmet: CSP (`script-src 'self'`, `frame-ancestors 'none'`, `object-src 'none'`), HSTS, nosniff, `Referrer-Policy: no-referrer`; `x-powered-by` aus | [`src/app.ts`](../src/app.ts) |
| `COOKIE_SECURE=true`, `TRUST_PROXY=false`, `NODE_ENV=production` als Default | [`src/config.ts`](../src/config.ts) |
| Session-Cookie `HttpOnly`, `SameSite=Strict`, `Path=/api/admin`, Ablaufzeit | [`src/middleware/auth.ts`](../src/middleware/auth.ts) |
| Body nur JSON ≤ 10 kB, `query parser: simple`, `Cache-Control: no-store`, Rate-Limits (global + Login) | [`src/app.ts`](../src/app.ts), [`src/routes/admin.ts`](../src/routes/admin.ts) |
| Nur parametrisierte SQL; dynamische Spalten nur über feste Zuordnung | [`src/services/productService.ts`](../src/services/productService.ts) |
| Passwort: scrypt mit Salt; Tokens: 256 Bit `crypto.randomBytes`, in der DB nur SHA-256 | [`src/services/crypto.ts`](../src/services/crypto.ts) |
| DB-Constraints als zweite Linie (Bestand ≥ 0, Preis > 0, Status-Enum) | [`db/migrations/001_init.sql`](../db/migrations/001_init.sql) |
| Container: non-root, `read_only`, `cap_drop: ALL`, `no-new-privileges`, DB-Port nicht exponiert, App nur auf 127.0.0.1 | [`Dockerfile`](../Dockerfile), [`docker-compose.yml`](../docker-compose.yml) |

**Fehlerbehandlung:** Explizite Fehlerklassen ([`src/errors.ts`](../src/errors.ts)) mit Status, stabilem Code und *öffentlicher* Meldung. Der zentrale Handler ([`src/middleware/errorHandler.ts`](../src/middleware/errorHandler.ts)) unterscheidet erwartete Fehler (→ definierte Antwort), Parser-Fehler (→ 400/413) und Unerwartetes (→ generische 500, Stacktrace nur ins Log). Jede Antwort trägt die `requestId`. Weitere explizite Fälle: Überverkauf (409 + betroffene IDs), ungültige Statusübergänge (409), doppelter Produktname (409), `unhandledRejection`/`uncaughtException` → `fatal`-Log + kontrollierter Exit, Graceful Shutdown, Statement-Timeout in der DB.
Positivtests: `failfast.test.ts` (*Sichere Fehlerbehandlung*, *Sichere Defaults*), `admin.test.ts` (Cookie-Flags, Enumeration, Logout, Ablauf, Rate-Limit), `shop.test.ts` (Überverkauf atomar, IDOR, Token-Hash).

### 2.3 SAST & Secret Scanning (automatisiert)
| Tool | Was es findet | Wann | Konfiguration |
|---|---|---|---|
| **ESLint** + `eslint-plugin-security` + `typescript-eslint strict-type-checked` | eval, unsichere RegExp/FS-Zugriffe, unsichere `any`-Flüsse; im Frontend `innerHTML`/`insertAdjacentHTML` | pre-commit, CI | [`eslint.config.js`](../eslint.config.js) |
| **Semgrep** (p/javascript, p/typescript, p/nodejsscan, p/expressjs, p/secrets + 5 eigene Regeln) | Injection, XSS-Senken, schwache Zufallszahlen, unsichere Cookies, Fehlerdetails an Client | CI bei Push/PR + wöchentlich; blockiert ab WARNING | [`security.yml`](../.github/workflows/security.yml), [`.semgrep/project-rules.yml`](../.semgrep/project-rules.yml) |
| **CodeQL** (security-extended) | Taint-/Datenfluss-Analyse über Funktionsgrenzen | CI (öffentliche Repos) | [`security.yml`](../.github/workflows/security.yml) |
| **gitleaks** (Default-Regeln + eigene Regel für Admin/DB-Passwörter) | Secrets im Code und in der **gesamten Git-Historie** | pre-commit (lokal), CI | [`.gitleaks.toml`](../.gitleaks.toml), [`.husky/pre-commit`](../.husky/pre-commit) |
| **Trivy** (secret + misconfig im Image) | Secrets/Fehlkonfiguration im fertigen Image | CI, Release | [`ci.yml`](../.github/workflows/ci.yml) |

**Positivtests** (je Scanner ein Problem, das erkannt wird und den Lauf scheitern lässt; erzeugt mit `npm run demo-branches`, siehe [`scripts/create-demo-branches.mjs`](../scripts/create-demo-branches.mjs)):

| Branch | Eingebautes Problem | Erwartung |
|---|---|---|
| `demo/sast-sqli` | SQL per String-Verkettung | Semgrep ❌ (`pizza-sql-string-concat`) |
| `demo/xss-frontend` | `innerHTML` mit Produktname / `location.hash` | ESLint ❌, Semgrep ❌ (`pizza-dom-xss-sink`) |
| `demo/secret-leak` | `deploy/prod.env` mit Admin-Passwort + GitHub-Token-Format | gitleaks ❌ |
| Fail Fast | ungültige Eingaben | automatisierter Test (s. 2.1) |

Lokale Reproduktion/Ergebnisse: [`evidence/code-security/semgrep-positivtest-lokal.txt`](evidence/code-security/semgrep-positivtest-lokal.txt).

**Umgang mit False Positives:** INFO-Befunde blockieren nicht (es sind Bestätigungen wie „Helmet gesetzt“). Ein echter False Positive (ReDoS-Warnung an einer linearen Regex) ist im Code per `nosemgrep` **mit Begründung** markiert; ESLint-Ausnahmen ebenso (`-- Begründung`). Ausnahmen sind damit reviewbar statt global abgeschaltet.

### Vertiefung: mitigierte Risiken / Restrisiken
| Mitigiert | Restrisiko / nächste Schritte |
|---|---|
| SQL-Injection (Parameter + Schema + SAST) | Semgrep-Regeln sind musterbasiert – neue Query-Muster (z.B. ORM) bräuchten neue Regeln; CodeQL deckt Datenfluss ab, ist aber für private Repos nur mit GHAS verfügbar |
| Mass Assignment / Preismanipulation | – |
| XSS (textContent, CSP, Lint, SAST) | Drittanbieter-Skripte würden die CSP aufweichen – bewusst keine |
| CSRF (SameSite=Strict, JSON-Zwang, Origin-Check) | sehr alte Browser ohne SameSite → Origin-Check als zweite Linie |
| Brute Force / Enumeration | Rate-Limit ist pro Instanz im Speicher; bei mehreren Replikas zentraler Store (Redis) nötig; kein 2FA |
| Secrets im Repo | gitleaks ist regex-/entropiebasiert → nicht jedes Secret-Format wird erkannt; ein durchgerutschtes Secret muss rotiert werden. Secrets liegen in `.env` (nicht versioniert); nächster Schritt: Secret-Store (z.B. Docker Secrets) |
| Fehler-Informationsabfluss | – |
| TLS | App spricht HTTP; TLS terminiert ein Reverse-Proxy (nicht Teil des Repos) |

---

## 3. Build & Supply Chain — alle vier Punkte ✔

| Kriterium | Umsetzung | Nachweis / lokale Reproduktion |
|---|---|---|
| 3.1 **(Pflicht)** Versionen mit Tag + Prüfsumme/Commit | Alle GitHub Actions per **Commit-SHA** (Tag als Kommentar); Basis-Images `node:24.22.3-alpine@sha256:…`, `postgres:17.12-alpine@sha256:…`, `semgrep/semgrep:1.186.0@sha256:…`; npm über `package-lock.json` (Version + `integrity`-Hash), Installation nur mit `npm ci`; zusätzlich `npm audit signatures` | [`Dockerfile`](../Dockerfile), [`docker-compose.yml`](../docker-compose.yml), [`.github/workflows/`](../.github/workflows/), [`package-lock.json`](../package-lock.json) |
| 3.2 SBOM automatisiert | Release-Workflow erzeugt **CycloneDX-SBOM** (Syft) aus dem veröffentlichten Image → Workflow-Artefakt + Anhang am GitHub-Release; zusätzlich BuildKit-SBOM-/Provenance-Attestation am Image | Releases → `sbom.cdx.json`; lokal: `npm run sbom` |
| 3.3 Schwachstellen-Prüfung | `npm audit --audit-level=high` (CI + build.sh), **Trivy**-Scan des Images (HIGH/CRITICAL mit Fix ⇒ Abbruch, *vor* dem Push) | Actions → CI/Release; lokal `npm run audit`. Positivtest: Branch `demo/vulnerable-dependency` (lodash 4.17.20) ⇒ `npm audit` ❌ |
| 3.4 Update-Werkzeug | **Dependabot** für npm, Dockerfile, Compose und Actions; on-demand über „Check for updates“; Abweichung vom Standard: Gruppierung (siehe Kommentare) | [`.github/dependabot.yml`](../.github/dependabot.yml), README → *Abhängigkeiten aktualisieren* |

Weitere Maßnahmen: `npm ci --ignore-scripts` (keine Install-Hooks fremder Pakete), minimale Abhängigkeiten (6 Laufzeit-Pakete; Cookie-Parsing und Passwort-Hashing ohne Zusatzpakete), Workflow-Token standardmäßig `contents: read`, Schreibrechte nur im Publish-Job, `persist-credentials: false`.

---

## 4. Logging & Betrieb — **VERTIEFUNG** (alle Punkte + Log-Auswertung)

### 4.1 Strukturierte, maschinenlesbare Logs
- **pino**, eine JSON-Zeile pro Ereignis auf **STDOUT** (Container-Standard) und optional in eine Datei (`LOG_FILE`) – [`src/logger.ts`](../src/logger.ts).
- Einheitliche Felder: `time` (ISO), `level` + `levelValue`, `service`, `event`, `requestId`, ggf. `adminId`. Fachliche Events (`order.created`, `audit`, `admin.login.failed`, `health.heartbeat`, …) sind im [README](../README.md#logs) katalogisiert → Monitoring kann nach `event` filtern statt Freitext zu parsen.
- **Korrelation:** `requestId` steht im Log *und* in der Fehlerantwort / im Header `X-Request-Id` (Client-IDs nur bei sicherem Format übernommen).
- **Datenschutz/Sicherheit:** Redaction von Passwort, Token, Cookie, Telefon; Pfade ohne Query-String; Steuerzeichen werden schon bei der Validierung abgelehnt; Bestell-Events ohne Personendaten. Nachweis: Demo-Log enthält weder Passwort noch Telefonnummer.
- **Rotation:** Docker `json-file` mit `max-size`/`max-file` ([`docker-compose.yml`](../docker-compose.yml)).

### 4.2 Health Check der Anwendung
- `/healthz` (Liveness) und `/readyz` (Readiness: DB erreichbar **und** Schema vollständig migriert, mit 2-s-Timeout) – [`src/health.ts`](../src/health.ts).
- Docker-`HEALTHCHECK` im Image ([`Dockerfile`](../Dockerfile)), Postgres-Healthcheck + `depends_on: service_healthy` in Compose.
- Positivtests: `/readyz` ⇒ 503 ohne DB (`failfast.test.ts`), ⇒ 200 mit DB (`shop.test.ts`).

### 4.3 Separates Health-Check-Skript
- [`scripts/healthcheck.sh`](../scripts/healthcheck.sh), [`scripts/healthcheck.ps1`](../scripts/healthcheck.ps1), im Container [`src/tools/healthcheck.ts`](../src/tools/healthcheck.ts): Ausgabe `HEALTHY` / `UNHEALTHY: <Grund>`, Exit 0/1. Unterscheidet *nicht erreichbar*, *Datenbank down* und *Schema veraltet*.
- Nutzung und **Behebung** jedes ungesunden Zustands: README → [*Troubleshooting*](../README.md#troubleshooting-unhealthy-beheben).

### 4.4 Log-Auswertung: Verfügbarkeit & Fehlerquote (Vertiefung)
- Die App schreibt alle 30 s ein `health.heartbeat`-Event (healthy/unhealthy + Checks). [`src/tools/analyze-logs.ts`](../src/tools/analyze-logs.ts) ([Logik](../src/tools/logAnalysis.ts), [Tests](../tests/unit/logAnalysis.test.ts)) berechnet daraus:
  - **Verfügbarkeit %**, Uptime/Downtime – unhealthy-Heartbeats zählen als Ausfall, **Lücken > 2 Intervalle** (Prozess weg/hängt) ebenfalls;
  - Neustarts (`app.started`);
  - **Anzahl und Quote der Error-Events** (`level ≥ error`), **5xx-Quote** der Requests, häufigste Fehler-Events;
  - Optionen `--since`, `--format md|json`, `--min-availability <pct>` (Exit 2 ⇒ für Alerting/Cron nutzbar).
- Funktioniert mit Datei, `docker compose logs` per Pipe oder im Container (kein externes Monitoring nötig).
- **Nachweis (DB-Ausfall-Demo):** App mit 5-s-Heartbeat gestartet, Bestellung + Admin-Aktionen durchgeführt, dann Datenbank gestoppt:
  - Health-Check-Skript ⇒ `UNHEALTHY: HTTP 503, fehlgeschlagen: database=down` ([healthcheck-unhealthy.txt](evidence/logging/healthcheck-unhealthy.txt))
  - Analyse ⇒ **Verfügbarkeit 71,43 %**, 4 unhealthy-Heartbeats, Error-Events nach Typ, Alarm bei `--min-availability 99` ([Bericht](evidence/logging/demo-db-outage-analyse.md), [Roh-Log](evidence/logging/demo-db-outage.log))

### Vertiefung: mitigierte Risiken / Restrisiken
| Mitigiert | Restrisiko / nächste Schritte |
|---|---|
| Ausfälle bleiben unbemerkt → Health Checks + Heartbeat + Alarm-Exit-Code | Heartbeat misst *Selbstsicht* der App; ein Ausfall des Netzwerks davor wird nicht erkannt → externer Blackbox-Check (z.B. Uptime-Kuma) als nächster Schritt |
| Angriffe/Missbrauch unsichtbar → `admin.login.failed`, `rate_limited`, `audit`, 4xx-Logs | Keine automatische Alarmierung bei Angriffsmustern; nächster Schritt: Logs an Loki/ELK + Alert-Regeln |
| Fehleranalyse ohne Kontext → requestId-Korrelation, Fehlerklassen, Stacktrace im Log | – |
| Datenschutzverstoß durch Logs → Redaction, keine Personendaten in Events | Redaction greift nur auf bekannte Feldnamen; neue Felder müssen ergänzt werden |
| Manipulation von Logs | Logs liegen lokal und sind nicht signiert; zentrale, append-only Ablage wäre nächster Schritt |

---

## 5. Dynamisches Testing — Mindestmaß ✔ (Punkt 1)

| Kriterium | Umsetzung | Nachweis |
|---|---|---|
| 5.1 Automatisierte Anwendungstests | **61 Tests** (vitest + supertest): Unit (ohne DB) und Integration gegen echte PostgreSQL (CI-Service-Container): Katalog, Bestellung, Überverkauf atomar, parallele Bestellungen, IDOR, Admin-Auth, Sortiment, Bestand, Statusautomat, Storno-Rückbuchung, Security-Header, Fail Fast, Log-Auswertung. Läuft bei jedem Push/PR. | [`tests/`](../tests/), [Testbericht](evidence/testing/testbericht.md), Actions → CI → *Anwendungstests* (JUnit-Artefakt + Job-Summary) |
| Scheitern bei fehlerhafter Änderung | Branch `demo/broken-stock`: Bestand wird nicht mehr reduziert ⇒ 2 Tests ❌ | [lokaler Nachweis](evidence/testing/positivtest-broken-stock-lokal.txt), CI-Lauf des Branches |

Nächster Schritt (nicht umgesetzt): DAST mit OWASP ZAP (API-Scan gegen die per Compose gestartete App, `workflow_dispatch`).
