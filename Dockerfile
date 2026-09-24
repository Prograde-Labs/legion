# Legion runtime image.
#
# Build:  docker build -t legion .
# Run:    docker run -p 3000:3000 -v legion-data:/data \
#           -e HOST=0.0.0.0 -e LEGION_BOOTSTRAP_PASSWORD=... [-e TELEGRAM_BOT_TOKEN=...] legion
#
# Workspace state (config.json, .legion/) lives entirely in the /data volume;
# the image is immutable and upgradable. On first boot Legion bootstraps the
# workspace in /data (operator credentials via LEGION_BOOTSTRAP_PASSWORD).
#
# Alpine base: @node-rs/argon2 ships musl prebuilds, so no glibc compat layer
# is needed. Multi-stage keeps dev tooling out of the final image.

FROM node:20-alpine AS build
WORKDIR /app

# node-pty has no musl-arm64 prebuild and compiles from source via node-gyp.
RUN apk add --no-cache python3 make g++

# Install dependencies first (manifest-only layer caches well).
COPY package.json package-lock.json ./
COPY packages/types/package.json packages/types/
COPY packages/core/package.json packages/core/
COPY packages/runtime/package.json packages/runtime/
COPY packages/web/package.json packages/web/
COPY packages/e2e/package.json packages/e2e/
RUN npm ci

# Copy sources and build: backend via tsc project references, web SPA via vite.
COPY tsconfig.json tsconfig.base.json ./
COPY packages ./packages
RUN npm run build && npm run build --workspace=packages/web
# Drop devDependencies from the installed tree for the runtime stage.
RUN npm prune --omit=dev

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/types ./packages/types
COPY --from=build /app/packages/core ./packages/core
COPY --from=build /app/packages/runtime ./packages/runtime
COPY --from=build /app/packages/web/dist ./packages/web/dist

# /data holds the Legion workspace volume.
RUN mkdir -p /data && chown node:node /data
USER node

EXPOSE 3000
VOLUME ["/data"]

ENTRYPOINT ["node", "packages/runtime/bin/legion.js"]
CMD ["/data"]
