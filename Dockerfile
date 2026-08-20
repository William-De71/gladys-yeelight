# -----------------------------------------------------------------------------
# Yeelight integration image.
#
# Gladys sandbox constraints ("the sandbox is the defense"):
#   - rootfs mounted READ-ONLY -> never write outside /data
#   - a single writable volume: /data
#   - runs as a non-root user
#   - multi-arch image (linux/amd64 + linux/arm64), see the CI workflow
#
# No extra system package and no runtime dependency beyond the Gladys SDK: the
# Yeelight LAN protocol is line-delimited JSON over TCP, implemented here on
# Node's built-in `net` module.
# -----------------------------------------------------------------------------

FROM node:24-alpine

# dumb-init: correct signal handling (SIGTERM) for a graceful shutdown, which
# here means closing every connection so each bulb frees one of its 4 slots.
RUN apk add --no-cache dumb-init

WORKDIR /app

# Install the PROD dependencies first (better build cache).
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

# Then the integration code.
COPY index.js ./
COPY src ./src
COPY gladys-assistant-integration.json ./

# The only writable location allowed at runtime. Created and handed to the
# unprivileged user before the USER switch: a bare VOLUME is owned by root, so
# without this the declared volume is read-only in practice. This integration
# stores nothing there today (no token, no certificate to persist), but a
# volume that cannot be written is a trap for whoever adds that later.
ENV NODE_ENV=production
RUN mkdir -p /data && chown -R node:node /data
VOLUME ["/data"]

# Run as an unprivileged user (already present in the node image).
USER node

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "index.js"]
