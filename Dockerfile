# Legion — multi-agent collective framework
#
# Build:  docker build -t legion .
# Run:    docker run -p 3000:3000 -v legion-data:/data -e LEGION_BOOTSTRAP_PASSWORD=... legion
#
# Workspace data (conversations, participants, credentials, config) lives under
# LEGION_WORKSPACE — mounted at /data so it survives container replacement.

# ---------- build stage: compile all packages + web SPA ----------
FROM node:22-alpine AS build
WORKDIR /app

# Install exact dependency tree first (cache-friendly layer)
COPY package.json package-lock.json ./
COPY packages/types/package.json packages/types/
COPY packages/core/package.json packages/core/
COPY packages/runtime/package.json packages/runtime/
COPY packages/web/package.json packages/web/
COPY packages/e2e/package.json packages/e2e/
RUN npm ci --no-audit --no-fund

# Compile: tsc --build for types/core/runtime, vite build for the web SPA
COPY tsconfig*.json ./
COPY packages packages
RUN npm run build && npm run build --workspace=packages/web

# ---------- runtime stage: production deps + compiled output ----------
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production \
    LEGION_WORKSPACE=/data \
    LEGION_HOST=0.0.0.0

# Production dependency tree (workspace symlinks need every package.json)
COPY package.json package-lock.json ./
COPY packages/types/package.json packages/types/
COPY packages/core/package.json packages/core/
COPY packages/runtime/package.json packages/runtime/
COPY packages/web/package.json packages/web/
COPY packages/e2e/package.json packages/e2e/
RUN npm ci --omit=dev --no-audit --no-fund

# Compiled JS from the build stage (dist/ per package + web SPA assets)
COPY --from=build /app/packages/types/dist packages/types/dist
COPY --from=build /app/packages/core/dist packages/core/dist
COPY --from=build /app/packages/runtime/dist packages/runtime/dist
COPY --from=build /app/packages/web/dist packages/web/dist
COPY packages/runtime/bin packages/runtime/bin

RUN mkdir -p /data && chown node:node /data
VOLUME /data
EXPOSE 3000
USER node

CMD ["node", "packages/runtime/bin/legion.js"]
