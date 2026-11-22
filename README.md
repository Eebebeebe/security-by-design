# 🍕 Pizzeria Sicher – Security-by-Design-Webshop

Ein kleiner Pizza-Webshop (Web-API + Website + PostgreSQL), an dem **DevSecOps- und Security-by-Design-Maßnahmen** praktisch umgesetzt und nachgewiesen werden. Die App ist bewusst überschaubar, bietet aber echte Angriffsfläche: Eingaben, Datenflüsse in eine Datenbank, eine Bestandslogik mit Nebenläufigkeit und einen geschützten Admin-Bereich.

➡️ **Schutzkonzept (Prüfungsdokument):** [docs/SCHUTZKONZEPT.md](docs/SCHUTZKONZEPT.md)
➡️ **Datenfluss & Vertrauensgrenzen:** [docs/datenfluss.md](docs/datenfluss.md)
➡️ **Nachweise:** [docs/evidence/](docs/evidence/README.md)

---

## Was kann die App?

### Shop (öffentlich) – `http://localhost:3000`
- Speisekarte mit Suche und Kategorien (Pizza, Getränke, Desserts). Angezeigt werden nur Produkte, die **im Sortiment** sind und **Bestand** haben.
- Warenkorb und Bestellung mit Lieferadresse. Preise und Summe berechnet **ausschließlich der Server**.
- Nach der Bestellung: Bestellnummer + geheimer **Tracking-Code**. Damit lässt sich der Status abfragen (Eingegangen → Im Ofen → Unterwegs → Geliefert).

### Admin-Panel – `http://localhost:3000/admin.html`
- Login (Benutzer/Passwort aus der Konfiguration, Session-Cookie, Brute-Force-Bremse).
- **Sortiment:** Produkte anlegen, bearbeiten, **aus dem Sortiment nehmen** und wieder aufnehmen.
- **Bestandskontrolle:** Bestand setzen oder relativ anpassen (z.B. +10 nach Lieferung). Bestand kann nie negativ werden.
- **Bestellungen:** Liste mit Kundendaten, Statuswechsel nach festem Ablauf; Stornierung bucht den Bestand automatisch zurück.
- Jede Admin-Aktion erzeugt einen Audit-Log-Eintrag (wer, was, vorher/nachher).

### API (Auszug)

| Methode | Pfad | Zweck | Schutz |
|---|---|---|---|
| GET | `/api/products?category=&q=` | Speisekarte | öffentlich |
| GET | `/api/products/:id` | Produktdetail | öffentlich |
| POST | `/api/orders` | Bestellung anlegen | öffentlich, Validierung, Rate-Limit |
| GET | `/api/orders/:id` + Header `X-Order-Token` | Bestellstatus | Tracking-Token |
| POST | `/api/admin/login` · `/logout` | Anmeldung | Rate-Limit, Origin-Check |
| GET/POST/PATCH | `/api/admin/products[/:id]` | Sortiment | Admin-Session |
| PATCH | `/api/admin/products/:id/stock` | Bestand | Admin-Session |
| GET / PATCH | `/api/admin/orders[/:id/status]` | Bestellungen | Admin-Session |
| GET | `/healthz` · `/readyz` | Liveness / Readiness | öffentlich |

Fehler kommen immer im Format `{ "error": { "code", "message", "requestId" } }` – die `requestId` findet sich im Log wieder.

---

## Installation

### Variante A: Fertiges Image aus der Registry (empfohlen)

Jeder Merge auf `main` veröffentlicht automatisch ein geprüftes Image nach GitHub Container Registry.
Voraussetzung: Docker mit Compose v2.

```bash
git clone https://github.com/Eebebeebe/security-by-design.git && cd security-by-design
cp .env.example .env
# .env bearbeiten: POSTGRES_PASSWORD und ADMIN_PASSWORD (min. 12 Zeichen) setzen
#   z.B.  openssl rand -base64 24
echo "APP_IMAGE=ghcr.io/eebebeebe/pizza-shop:latest" >> .env
docker compose up -d
./scripts/healthcheck.sh          # -> HEALTHY
```

Shop: <http://localhost:3000> · Admin: <http://localhost:3000/admin.html>

> Ohne gültiges `ADMIN_PASSWORD` startet der Container absichtlich **nicht** (Exit-Code 78, Log-Event `app.config.invalid`).
> Für einen exakt reproduzierbaren Stand statt `latest` den Digest aus den Release-Notizen verwenden: `ghcr.io/eebebeebe/pizza-shop@sha256:…`

### Variante B: Selbst bauen

```bash
cp .env.example .env              # Passwörter setzen
./scripts/build.sh                # Lint, Typcheck, Unit-Tests, npm audit, Docker-Build
APP_IMAGE=pizza-shop:local docker compose up -d
```

`scripts/build.sh --no-checks` baut nur das Image. `IMAGE=…` ändert den Image-Namen. Das Image wird mit dem Git-Commit getaggt (`pizza-shop:<sha>`).

### Variante C: Lokale Entwicklung (ohne Docker für die App)

Benötigt Node.js 24 (`.nvmrc`) und eine PostgreSQL-Instanz.

```bash
npm ci
docker compose up -d db           # oder eigene Postgres; Port dann in docker-compose freigeben
export DATABASE_URL=postgres://pizza:<pw>@localhost:5432/pizza
export ADMIN_PASSWORD="$(openssl rand -base64 24)" COOKIE_SECURE=true NODE_ENV=development
npm run dev                       # http://localhost:3000, Migrationen laufen automatisch
```

### Konfiguration

| Variable | Default | Bedeutung |
|---|---|---|
| `DATABASE_URL` | – (Pflicht) | `postgres://user:pw@host:5432/db` |
| `ADMIN_PASSWORD` | – (Pflicht, ≥ 12 Zeichen) | Initiales Admin-Passwort (nur beim ersten Start gesetzt) |
| `ADMIN_USERNAME` | `admin` | Admin-Benutzername |
| `PORT` | `3000` | HTTP-Port |
| `COOKIE_SECURE` | `true` | Session-Cookie nur über HTTPS (localhost ist für Browser ausgenommen) |
| `TRUST_PROXY` | `false` | Nur hinter eigenem Reverse-Proxy auf `true` |
| `SESSION_TTL_MINUTES` | `60` | Lebensdauer der Admin-Session |
| `LOG_LEVEL` | `info` | `fatal`…`trace` |
| `LOG_FILE` | – | Zusätzlich JSON-Logs in diese Datei (Compose: `/var/log/pizza/app.log`) |
| `HEARTBEAT_INTERVAL_MS` | `30000` | Abstand der Health-Heartbeats im Log |
| `LOGIN_RATE_LIMIT` | `10` | Login-Versuche pro IP und 15 min |

Jede Variable wird beim Start validiert; ungültige Werte → kein Start (Fail Fast).

---

## Entwicklung & Qualitätssicherung

| Befehl | Zweck |
|---|---|
| `npm run lint` | ESLint inkl. `eslint-plugin-security` und XSS-Regeln fürs Frontend |
| `npm run typecheck` | TypeScript (strict) statisch prüfen |
| `npm run test:unit` | Unit-Tests (ohne DB) |
| `npm test` | Alle Tests, braucht `DATABASE_URL` auf eine **leere Test-DB** |
| `npm run test:report` | Tests + Markdown-Bericht nach `docs/evidence/testing/testbericht.md` |
| `npm run audit` | Abhängigkeiten auf bekannte Schwachstellen prüfen |
| `npm run sbom` | SBOM (CycloneDX) der Laufzeit-Abhängigkeiten lokal erzeugen |
| `npm run deps:update` | Abhängigkeiten im erlaubten SemVer-Bereich aktualisieren + Audit |
| `npm run demo-branches` | Demo-Branches mit absichtlichen Fehlern für Positivtests anlegen |

Ein **pre-commit Hook** (husky) führt gitleaks (falls installiert), ESLint und den Typcheck aus.

### CI/CD (GitHub Actions)

| Workflow | Trigger | Inhalt |
|---|---|---|
| [`ci.yml`](.github/workflows/ci.yml) | Push (≠ main), PR | Lint, Typcheck, `npm audit`, Signaturen, Tests gegen Postgres, Docker-Build, Trivy, Fail-Fast-Smoke-Test |
| [`security.yml`](.github/workflows/security.yml) | Push (≠ main), PR, wöchentlich | Semgrep (SAST), CodeQL, gitleaks (gesamte Historie) |
| [`release.yml`](.github/workflows/release.yml) | Push/Merge auf `main` | alle Gates aus ci + security → Image bauen → Trivy-Gate → Push nach GHCR → SBOM → GitHub-Release |
| [`dependabot.yml`](.github/dependabot.yml) | wöchentlich / on-demand | Update-PRs für npm, Docker-Images, Compose, Actions |

Empfohlene Repository-Einstellung: **Branch Protection für `main`** (PR erforderlich, Status-Checks *CI* und *Security* müssen grün sein).

### Abhängigkeiten aktualisieren (Dependabot)

- Automatisch: jeden Montag öffnet Dependabot PRs (Dev-Tools gruppiert, Laufzeit-Pakete einzeln). Die PRs laufen durch alle Gates.
- **On-demand:** GitHub → *Insights* → *Dependency graph* → *Dependabot* → bei einem Ökosystem *Last checked … → Check for updates*.
- Abweichungen vom Standard: Gruppierung der Dev-Abhängigkeiten und der Actions; zusätzlich Ökosystem `docker-compose` (Postgres-Image). Siehe Kommentare in [`.github/dependabot.yml`](.github/dependabot.yml).
- Lokal ohne GitHub: `npm run deps:update`.

---

## Betrieb

### Health Checks
- `GET /healthz` – Prozess lebt (Liveness).
- `GET /readyz` – Datenbank erreichbar **und** Schema aktuell (Readiness). `200` = healthy, `503` = unhealthy.
- Der Container hat einen `HEALTHCHECK` → `docker compose ps` zeigt `healthy`/`unhealthy`.

**Health-Check-Skript** (für Cron, Monitoring, manuell):

```bash
./scripts/healthcheck.sh [URL]          # Linux/macOS/Git-Bash
.\scripts\healthcheck.ps1 [-Url URL]     # Windows
docker compose exec app node dist/tools/healthcheck.js   # im Container
```

Ausgabe `HEALTHY: …` (Exit 0) oder `UNHEALTHY: <Grund>` (Exit 1).

### Logs

Die App schreibt **eine JSON-Zeile pro Ereignis** auf STDOUT (und optional in `LOG_FILE`). Jedes relevante Ereignis hat ein Feld `event`:

| Event | Bedeutung |
|---|---|
| `http.request` | jede Anfrage: Methode, Pfad (ohne Query), Route, Status, Dauer, requestId |
| `order.created` | Bestellung (ohne Personendaten) |
| `admin.login.succeeded` / `.failed` / `.rate_limited` | Anmeldeversuche |
| `audit` | Admin-Aktion mit `action`, vorher/nachher |
| `health.heartbeat` | alle 30 s: healthy/unhealthy + Checks |
| `app.error.handled` / `app.error.unhandled` | erwartete / unerwartete Fehler (mit requestId) |
| `app.started`, `app.stopping`, `app.crash`, `app.config.invalid` | Lebenszyklus |

Passwörter, Tokens, Cookies und Telefonnummern werden automatisch geschwärzt (`[REDACTED]`).

### Log-Auswertung (Verfügbarkeit & Fehlerquote)

```bash
docker compose logs app --no-log-prefix | docker compose exec -T app node dist/tools/analyze-logs.js -
docker compose exec app node dist/tools/analyze-logs.js /var/log/pizza/app.log
npm run analyze-logs -- logs/app.log --since 2026-11-22T00:00:00Z
npm run analyze-logs -- logs/app.log --format json
npm run analyze-logs -- logs/app.log --min-availability 99.5   # Exit 2 bei Unterschreitung -> Alerting
```

Ergebnis: Verfügbarkeit in %, Uptime/Downtime, Heartbeat-Lücken (Prozess weg), Neustarts, Anzahl Requests, 5xx-Quote, Anzahl/Quote der Error-Events, häufigste Fehler. Beispiel: [docs/evidence/logging/demo-db-outage-analyse.md](docs/evidence/logging/demo-db-outage-analyse.md).

### Troubleshooting (UNHEALTHY beheben)

| Meldung | Ursache | Behebung |
|---|---|---|
| `UNHEALTHY: Anwendung … nicht erreichbar` | Container/Prozess läuft nicht, falscher Port | `docker compose ps`; `docker compose logs app --tail 50`. Event `app.config.invalid` → `.env` korrigieren (siehe `problems`). Event `app.startup.failed` → meist DB nicht erreichbar. Dann `docker compose up -d`. |
| `UNHEALTHY: Datenbank nicht erreichbar` | Postgres gestoppt, Netzwerk, falsches Passwort | `docker compose ps db`; `docker compose logs db`; `docker compose up -d db`. Passwort in `.env` und Volume müssen zusammenpassen. Die App verbindet sich automatisch neu – kein Neustart nötig. |
| `UNHEALTHY: Datenbankschema veraltet` | Migrationen fehlen (z.B. neue Version gegen alte DB) | `docker compose restart app` (Migrationen laufen beim Start) oder `npm run migrate`. |
| Container `unhealthy`, App antwortet aber | Health-Check-Timeout (DB sehr langsam) | `docker stats`, DB-Last prüfen; Log-Events `db.pool.error` ansehen. |
| Admin-Login immer 401 | Admin existiert schon mit altem Passwort (wird nicht überschrieben) | Passwort-Rotation: Benutzer in `admin_users` löschen und App neu starten – sie legt ihn mit dem aktuellen `ADMIN_PASSWORD` an. |
| Login 429 | Rate-Limit nach zu vielen Fehlversuchen | 15 min warten; Log-Event `admin.login.rate_limited` prüfen (Angriff?). |

---

## Projektstruktur

```
src/
  app.ts               Express-App, Middleware-Reihenfolge, Security-Header
  server.ts            Start: Config prüfen, Migrationen, Heartbeat, Graceful Shutdown
  config.ts            Validierte Konfiguration (zod) mit sicheren Defaults
  schemas/             Eingabe-Validierung (zod, Allowlist, strict)
  services/            Fachlogik: Bestellung (Transaktion, Locks), Produkte, Auth, Krypto
  middleware/          Request-Logging, Auth/CSRF, zentrale Fehlerbehandlung
  health.ts            /healthz, /readyz, Heartbeat
  tools/               healthcheck.ts, analyze-logs.ts (+ logAnalysis.ts)
db/migrations/         SQL-Schema mit DB-Constraints
public/                Frontend (Vanilla JS, kein innerHTML, strikte CSP)
tests/                 unit/ (ohne DB) und integration/ (Postgres)
scripts/               build.sh, healthcheck.sh/.ps1, create-demo-branches.mjs, junit-summary.mjs
.semgrep/              projektspezifische SAST-Regeln
.github/               Workflows, Dependabot
docs/                  Schutzkonzept, Datenfluss, Nachweise
```
