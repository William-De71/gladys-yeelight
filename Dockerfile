# -----------------------------------------------------------------------------
# Yeelight integration image.
#
# Gladys sandbox constraints ("the sandbox is the defense"):
#   - rootfs mounted READ-ONLY -> never write outside /data
#   - a single writable volume: /data
#   - runs as a non-root user
#   - multi-arch image (linux/amd64 + linux/arm64), see build.yml
#
# No extra system package and no runtime dependency beyond the Gladys SDK: the
# Yeelight LAN protocol is line-delimited JSON over TCP, implemented here on
# Node's built-in `net` module.
# -----------------------------------------------------------------------------

FROM node:24-alpine

# The version label and the manifest label are added by build.yml.
LABEL org.opencontainers.image.title="gladys-yeelight" \
      org.opencontainers.image.description="Local control of Yeelight Wi-Fi lights over the LAN protocol, in Gladys Assistant" \
      org.opencontainers.image.source="https://github.com/William-De71/gladys-yeelight" \
      org.opencontainers.image.licenses="Apache-2.0"

# dumb-init: correct signal handling (SIGTERM) for a graceful shutdown, which
# here means closing every connection so each bulb frees one of its 4 slots.
RUN apk add --no-cache dumb-init

WORKDIR /app

# Install the PROD dependencies first (better build cache). `npm ci` only:
# a lockfile out of sync with package.json must fail the build, not be
# silently re-resolved into an untested dependency tree.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

# Then the integration code.
COPY index.js ./
COPY src ./src
COPY gladys-assistant-integration.json LICENSE NOTICE ./

# The only writable location allowed at runtime. Docker creates a new volume
# with the owner of the image's /data, so it must belong to `node`, and before
# VOLUME: changes made to /data after it are discarded.
ENV NODE_ENV=production
RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]

# Run as an unprivileged user (already present in the node image).
USER node

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "index.js"]
