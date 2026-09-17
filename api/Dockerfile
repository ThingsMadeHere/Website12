# Production API image — reproducible builds via package-lock.json.
FROM node:22-slim

ENV NODE_ENV=production
WORKDIR /app

# Install deps first (cached layer) — exact versions from the lockfile.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm install ssh2 --omit=dev

# App source (api/.dockerignore keeps host node_modules, databases and
# secrets out of the image)
COPY . .

EXPOSE 3001

# Container-level healthcheck: `docker compose ps` reports health and the
# web service waits for this before starting (depends_on: service_healthy).
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3001/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

CMD ["node", "index.js"]
