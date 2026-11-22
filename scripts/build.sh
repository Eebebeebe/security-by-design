#!/usr/bin/env bash
# Baut das Docker-Artefakt reproduzierbar – lokal genau wie im CI.
#
#   ./scripts/build.sh            Qualitäts-Gates (lint, typecheck, unit-tests) + Docker-Image
#   ./scripts/build.sh --no-checks   nur Docker-Image bauen
#   IMAGE=ghcr.io/me/pizza-shop ./scripts/build.sh
#
# Ergebnis: Image <IMAGE>:<git-sha> und <IMAGE>:local
set -euo pipefail

cd "$(dirname "$0")/.."
IMAGE="${IMAGE:-pizza-shop}"
VERSION="$(git rev-parse --short HEAD 2>/dev/null || echo dev)"
if [ -n "$(git status --porcelain 2>/dev/null)" ]; then VERSION="${VERSION}-dirty"; fi

log() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }

if [ "${1:-}" != "--no-checks" ]; then
  log "Abhängigkeiten exakt nach Lockfile installieren (npm ci)"
  npm ci --ignore-scripts --no-fund
  log "Lint (inkl. eslint-plugin-security)"
  npm run lint
  log "Statischer Typcheck (tsc --noEmit)"
  npm run typecheck
  log "Unit-Tests"
  npm run test:unit
  log "Bekannte Schwachstellen in Abhängigkeiten (npm audit, ab high)"
  npm audit --audit-level=high --omit=dev
fi

log "Docker-Image bauen: ${IMAGE}:${VERSION}"
docker build --pull --build-arg VERSION="${VERSION}" -t "${IMAGE}:${VERSION}" -t "${IMAGE}:local" .

log "Fertig"
echo "Starten:  APP_IMAGE=${IMAGE}:${VERSION} docker compose up -d"
echo "Prüfen:   ./scripts/healthcheck.sh"
