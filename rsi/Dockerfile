# syntax=docker/dockerfile:1.7
ARG NODE_IMAGE=node:22.19.0-trixie-slim
FROM ${NODE_IMAGE}

SHELL ["/bin/sh", "-c"]
ENV DEBIAN_FRONTEND=noninteractive

RUN node -e "const [a,b]=process.versions.node.split('.').map(Number); if (a < 22 || (a === 22 && b < 19)) { console.error('Node >=22.19 is required'); process.exit(1); }" \
	&& apt-get update \
	&& apt-get install -y --no-install-recommends \
		bubblewrap \
		ca-certificates \
		procps \
		tzdata \
		uidmap \
		util-linux \
	&& rm -rf /var/lib/apt/lists/* \
	&& test -x /usr/bin/bwrap \
	&& test ! -u /usr/bin/bwrap \
	&& test -x /usr/bin/setpriv \
	&& test -x /usr/bin/newuidmap \
	&& bwrap --help 2>&1 | grep -q -- '--seccomp' \
	&& bwrap --help 2>&1 | grep -q -- '--unshare-user' \
	&& bwrap --version

# The Supervisor runs as root only inside this constrained container, so it can
# use setpriv to start bwrap as the dedicated non-root Worker host UID. The
# Worker itself is started with no capabilities by bubblewrap. Docker grants
# only SETUID/SETGID/CHOWN to the Supervisor for uid switching and volume repair.
RUN groupadd --gid 10002 rsi-worker \
	&& useradd --uid 10002 --gid 10002 --no-create-home --home-dir /data/worker-home --shell /usr/sbin/nologin rsi-worker

WORKDIR /opt/rsi
COPY rsi/package.json rsi/package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund \
	&& npm cache clean --force

COPY rsi/ ./
COPY markdowns/ /opt/rsi/seed-markdowns/
RUN node /opt/rsi/src/main.ts --help >/dev/null \
	&& chown -R root:root /opt/rsi/seed-markdowns \
	&& chmod -R a-w /opt/rsi/seed-markdowns \
	&& chmod 0755 /opt/rsi/scripts/*.sh /opt/rsi/bin/pi /opt/rsi/bin/rsi /opt/rsi/bin/rsi.mjs /opt/rsi/bin/pi.mjs \
	&& mkdir -p /tmp/rsi-build-home \
	&& HOME=/tmp/rsi-build-home node /opt/rsi/scripts/install-plugins.mjs \
		--agent-dir /opt/rsi/pi-agent-base \
		--source-root /opt/rsi \
	&& chmod -R a-w /opt/rsi/pi-agent-base \
	&& rm -rf /tmp/rsi-build-home

RUN install -d -m 0755 /data \
	&& install -d -m 0777 /data/workspace /data/plugins /data/pi-agent /data/pi-sessions /data/worker-home /data/tools /data/workflows \
	&& install -d -m 0755 /data/markdowns \
	&& install -d -m 0711 /state \
	&& install -d -m 0755 /state/snapshots /state/snapshots/candidates /state/snapshots/lkg \
	&& install -d -m 0700 /state/control /state/plugins /state/read-stats /state/logs /state/runtime \
	&& install -d -m 2770 -g 10002 /state/run \
	&& chown -R 10002:10002 /data/workspace /data/plugins /data/pi-agent /data/pi-sessions /data/worker-home /data/tools /data/workflows \
	&& chown root:root /data/markdowns /state \
	&& chown root:10002 /state/run \
	&& chmod 2770 /state/run \
	&& chmod 0755 /data/markdowns

ENV NODE_ENV=production \
	HOME=/data \
	PATH=/opt/rsi/bin:/opt/rsi/node_modules/.bin:$PATH \
	PI_CODING_AGENT_DIR=/data/pi-agent \
	PI_BASE_AGENT_DIR=/opt/rsi/pi-agent-base \
	RSI_CONFIG_PATH=/state/runtime/rsi.config.json \
	RSI_LOGS_DIR=/state/logs \
	RSI_HEALTH_FILE=/state/runtime/health.json \
	RSI_SUPERVISOR_ENTRY=/opt/rsi/src/main.ts \
	RSI_PI_REAL_CLI=/opt/rsi/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js \
	NPM_CONFIG_IGNORE_SCRIPTS=true \
	npm_config_ignore_scripts=true

VOLUME ["/data", "/state"]

HEALTHCHECK --interval=30s --timeout=10s --start-period=120s --retries=3 \
	CMD ["node", "/opt/rsi/scripts/container-healthcheck.mjs"]

STOPSIGNAL SIGTERM
ENTRYPOINT ["/opt/rsi/scripts/container-entrypoint.sh"]
