# syntax=docker/dockerfile:1
# Basis-Image mit exaktem Release-Tag UND Digest gepinnt (Supply Chain: reproduzierbar, nicht austauschbar).
# Aktualisierung über Dependabot (package-ecosystem: docker).
ARG NODE_IMAGE=node:24.22.3-alpine@sha256:116b800c3754b440ee0aa3ed2f20f5bf3d99a554bfd9adeea09ea8017f6e85f5

# ---------- Build-Stage: kompiliert TypeScript, enthält Dev-Abhängigkeiten ----------
FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json ./
# npm ci: installiert exakt den Lockfile-Stand inkl. Integritäts-Hashes; --ignore-scripts: keine install-Hooks fremder Pakete
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev --ignore-scripts

# ---------- Runtime-Stage: nur was zur Laufzeit nötig ist ----------
FROM ${NODE_IMAGE} AS runtime
ARG VERSION=dev
LABEL org.opencontainers.image.title="pizza-shop" \
      org.opencontainers.image.description="Pizza-Webshop (Security-by-Design-Demo)" \
      org.opencontainers.image.version="${VERSION}"
ENV NODE_ENV=production \
    PORT=3000
WORKDIR /app
# npm/npx/corepack werden zur Laufzeit nicht gebraucht -> entfernen (kleinere Angriffsfläche, weniger CVEs)
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
           /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack
# Dateien gehören root, der Prozess läuft als "node" -> die App kann ihren eigenen Code nicht verändern
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY public ./public
COPY db/migrations ./db/migrations
# Einziges beschreibbares Verzeichnis: Log-Datei (für scripts/analyze-logs). Rest bleibt read-only.
RUN mkdir -p /var/log/pizza && chown node:node /var/log/pizza
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "dist/tools/healthcheck.js"]
CMD ["node", "dist/server.js"]
