# syntax=docker/dockerfile:1
# Multi-stage build for production-ready Node.js backend
# Build context: project root (so we can COPY skills/ and config/)

# ---------- Builder stage ----------
FROM node:24-alpine AS builder

# Install build tools for native modules (better-sqlite3)
RUN apk add --no-cache python3 make g++ curl

WORKDIR /app

# Copy dependency manifests first for layer caching
COPY ts-backend/package.json ts-backend/package-lock.json ./
RUN npm ci --legacy-peer-deps

# Copy source and build
COPY ts-backend/tsconfig.json ./
COPY ts-backend/src ./src
RUN npm run build

# ---------- Production stage ----------
FROM node:24-alpine AS production

# Install curl for healthcheck
RUN apk add --no-cache curl

# Use the existing 'node' user (uid 1000) from the base image.
# This matches the typical first host user and avoids permission issues
# with volume mounts (./data/* on the host is usually owned by uid 1000).

WORKDIR /app

# Copy compiled output and dependencies
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./

# Copy runtime resources
COPY config/ /app/config/
COPY skills/ /app/skills/

# Create data directories and set ownership
RUN mkdir -p /app/data/tasks /app/data/db && \
    chown -R node:node /app/data

USER node

ENV NODE_ENV=production
ENV DATA_DIR=/app/data
ENV DATABASE_PATH=/app/data/db/tasks.db
ENV WORKSPACE_ROOT=/app/data/tasks
ENV CONFIG_DIR=/app/config
ENV SKILLS_DIR=/app/skills
ENV PORT=8000
ENV HOST=0.0.0.0

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -fsS http://localhost:$PORT/health || exit 1

CMD ["node", "dist/index.js"]
