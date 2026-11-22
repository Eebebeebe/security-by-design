# Nachweise

| Feld | Nachweis | Art |
|---|---|---|
| 2 Code Security | [code-security/semgrep-positivtest-lokal.txt](code-security/semgrep-positivtest-lokal.txt) | Semgrep- und ESLint-Positivtests (lokal) |
| 2 Code Security | CI-Läufe der Branches `demo/sast-sqli`, `demo/xss-frontend`, `demo/secret-leak` | rote Läufe (Actions) – Links nach dem ersten Push ergänzen |
| 2 Code Security | [`tests/unit/failfast.test.ts`](../../tests/unit/failfast.test.ts) | Fail-Fast-Positivtest (läuft in jeder CI) |
| 3 Supply Chain | Releases → `sbom.cdx.json`, `trivy-report.txt` | SBOM + Image-Scan je Release |
| 3 Supply Chain | CI-Lauf `demo/vulnerable-dependency` | `npm audit` schlägt an |
| 4 Logging & Betrieb | [logging/demo-db-outage.log](logging/demo-db-outage.log) | echtes JSON-Log (Bestellung, Admin, DB-Ausfall) |
| 4 Logging & Betrieb | [logging/demo-db-outage-analyse.md](logging/demo-db-outage-analyse.md) | Auswertung: Verfügbarkeit 71,43 %, Error-Events |
| 4 Logging & Betrieb | [logging/healthcheck-unhealthy.txt](logging/healthcheck-unhealthy.txt) | Health-Check-Skript erkennt DB-Ausfall |
| 5 Testing | [testing/testbericht.md](testing/testbericht.md) | lesbarer Testbericht (61/61) |
| 5 Testing | [testing/positivtest-broken-stock-lokal.txt](testing/positivtest-broken-stock-lokal.txt) | Tests scheitern bei fehlerhafter Änderung |

Aktualisieren: `npm run test:report` (Testbericht), `npm run analyze-logs -- <log> > logging/….md` (Log-Auswertung), `npm run demo-branches` + Push (CI-Positivtests).
