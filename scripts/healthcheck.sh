#!/usr/bin/env bash
# Prüft, ob der Pizza-Shop arbeitsfähig ist. Ausgabe: HEALTHY oder UNHEALTHY (+ Grund).
# Exit-Code: 0 = HEALTHY, 1 = UNHEALTHY  -> nutzbar in Cron, Monitoring, CI.
#
#   ./scripts/healthcheck.sh                     (Default: http://127.0.0.1:3000)
#   ./scripts/healthcheck.sh https://shop.example.org
#
# Was wird geprüft?
#   1. /healthz  – lebt der Prozess / ist der Port erreichbar?
#   2. /readyz   – ist die Datenbank erreichbar und das Schema aktuell?
# Behebung eines UNHEALTHY-Zustands: siehe README.md, Abschnitt "Troubleshooting".
set -uo pipefail

BASE="${1:-${HEALTHCHECK_URL:-http://127.0.0.1:3000}}"
BASE="${BASE%/}"

if ! curl -fsS --max-time 4 "$BASE/healthz" >/dev/null 2>&1; then
  echo "UNHEALTHY: Anwendung unter $BASE nicht erreichbar (Prozess/Container läuft nicht oder Port falsch)"
  exit 1
fi

BODY="$(curl -sS --max-time 4 -w '\n%{http_code}' "$BASE/readyz" 2>/dev/null)"
CODE="$(printf '%s' "$BODY" | tail -n1)"
JSON="$(printf '%s' "$BODY" | sed '$d')"

if [ "$CODE" = "200" ] && printf '%s' "$JSON" | grep -q '"status":"healthy"'; then
  echo "HEALTHY: $JSON"
  exit 0
fi

REASONS=()
printf '%s' "$JSON" | grep -q '"database":"down"' && REASONS+=("Datenbank nicht erreichbar")
printf '%s' "$JSON" | grep -q '"migrations":"pending"' && REASONS+=("Datenbankschema veraltet (Migrationen fehlen)")
[ ${#REASONS[@]} -eq 0 ] && REASONS+=("HTTP $CODE: $JSON")
echo "UNHEALTHY: $(IFS='; '; echo "${REASONS[*]}")"
exit 1
