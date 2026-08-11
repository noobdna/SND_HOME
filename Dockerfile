# SND@HOME container image. See PHASE6_DOCKER_PLAN.md for the full design
# rationale -- in short: Debian-slim (not Alpine) because collectors/
# diskCollector.js and collectors/networkCollector.js already parse `df`/
# `netstat` output written against BSD/GNU dialects (README's Tech Stack
# "Platform note"), and lan/lanScanner.js's `arp`/`ip neigh` parsers are in
# the same boat -- Alpine's BusyBox userland would be a third output
# dialect to trust, on top of an already-documented gap. Single-stage:
# this app has no build step, no bundler, and no native/compiled
# dependencies to build in an earlier stage (README's own "no build step,
# no bundler" framing extends cleanly here).
FROM node:20-bookworm-slim

# Packages providing the system commands this app already shells out to
# natively (child_process.execFile, never spawned as root-requiring):
#   iputils-ping -> ping           (lan/lanScanner.js: pingHost)
#   net-tools    -> arp, netstat   (lan/lanScanner.js: readArpTable's
#                                    primary path; collectors/networkCollector.js)
#   iproute2     -> ip             (lan/lanScanner.js: readArpTable's
#                                    fallback path when arp is unavailable)
# `df` needs nothing extra -- it's part of coreutils, already in the base
# image. --no-install-recommends plus clearing the apt list cache keeps
# the image from carrying apt's own metadata around at runtime.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       iputils-ping \
       net-tools \
       iproute2 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Separate the dependency-install layer from the source-copy layer so
# `npm ci` is only re-run when package*.json actually changes, not on
# every source edit.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

# data/ is meant to be bind-mounted at run time (see docker-compose.yml
# and PHASE6_DOCKER_PLAN.md's Persistence section) -- what ships in the
# image itself is only the placeholder directory, not any real ledger/rule
# data, so a fresh `docker run` without the compose file's volume still
# boots cleanly (deviceStore.js/ruleStore.js's own "file doesn't exist yet"
# first-run paths, unchanged).
RUN mkdir -p data

EXPOSE 3000

# node -e rather than curl/wget specifically so the image doesn't need
# either installed just for this -- node is already there by definition.
# Hits the already-existing GET /api/health (README's API table), no new
# endpoint introduced for this.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://localhost:'+(process.env.PORT||3000)+'/api/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "server.js"]
