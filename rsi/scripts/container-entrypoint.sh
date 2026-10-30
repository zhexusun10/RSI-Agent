#!/bin/sh
set -eu
umask 022

RUNTIME_ROOT=/opt/rsi
CONFIG_PATH=${RSI_CONFIG_PATH:-/state/runtime/rsi.config.json}
PROMPT_PATH=/run/config/system-prompt.txt
WORKER_UID=${RSI_WORKER_UID:-10002}
WORKER_GID=${RSI_WORKER_GID:-10002}
TZ=${RSI_TIME_ZONE:-${TZ:-UTC}}
export TZ

log() {
	printf '[rsi-entrypoint] %s\n' "$*" >&2
}

fail() {
	printf '[rsi-entrypoint] ERROR: %s\n' "$*" >&2
	exit 1
}

# The trusted Supervisor must be root inside this constrained container so that
# setpriv can start bubblewrap under the distinct Worker host UID. If that
# precondition is unavailable, fail closed; there is no unsandboxed fallback.
if [ "$(id -u)" != "0" ]; then
	fail "the Supervisor must run as root inside the container to start bwrap as Worker uid $WORKER_UID; no unsandboxed fallback is available"
fi

[ -x /usr/bin/bwrap ] || fail "bubblewrap is not installed at /usr/bin/bwrap"
[ -x /usr/bin/setpriv ] || fail "setpriv is not installed at /usr/bin/setpriv"
[ -f /opt/rsi/pi-agent-base/settings.json ] || fail "immutable Pi baseline is missing: /opt/rsi/pi-agent-base"
[ -s "$PROMPT_PATH" ] || fail "manual system prompt is missing or empty: $PROMPT_PATH (bind-mount it read-only; no prompt is generated)"

install -d -m 0755 /data
install -d -m 0777 /data/workspace /data/plugins /data/pi-agent /data/pi-sessions /data/worker-home
install -d -m 0777 /data/tools /data/workflows
install -d -m 0755 /data/markdowns
install -d -m 0711 /state
install -d -m 0755 /state/snapshots /state/snapshots/candidates /state/snapshots/lkg
install -d -m 0700 /state/control /state/plugins /state/read-stats /state/logs /state/runtime
install -d -m 2770 -g "$WORKER_GID" /state/run
chown -R "$WORKER_UID:$WORKER_GID" /data/workspace /data/plugins /data/pi-agent /data/pi-sessions /data/worker-home /data/tools /data/workflows 2>/dev/null \
	|| fail "cannot give the Worker ownership of writable /data directories"
chown root:root /data/markdowns /state 2>/dev/null || fail "cannot keep /data/markdowns and /state Supervisor-owned"
chmod 0755 /data/markdowns
chown root:"$WORKER_GID" /state/run 2>/dev/null || fail "cannot set /state/run group to $WORKER_GID"
chmod 2770 /state/run

[ -w /data ] || fail "/data is not writable by the Supervisor"
[ -w /state ] || fail "/state is not writable by the Supervisor"

if [ ! -f /data/pi-agent/settings.json ]; then
	cp /opt/rsi/pi-agent-base/settings.json /data/pi-agent/settings.json
	log "seeded Pi settings from the immutable baseline"
fi
if [ ! -e /data/pi-agent/npm ] && [ -d /opt/rsi/pi-agent-base/npm ]; then
	cp -R /opt/rsi/pi-agent-base/npm /data/pi-agent/npm
	chown -R "$WORKER_UID:$WORKER_GID" /data/pi-agent/npm
	log "seeded pinned Pi packages from the immutable baseline"
fi

# Operator Pi config is root-owned/group-readable and read-only in the Worker.
# Keep an existing operator file; otherwise create a valid empty file so a
# missing path cannot be created by the Agent later.
if [ -f /run/secrets/pi-auth.json ] && [ ! -e /data/pi-agent/auth.json ]; then
	cp /run/secrets/pi-auth.json /data/pi-agent/auth.json
	log "installed Pi auth.json from the read-only secret mount"
fi
if [ ! -e /data/pi-agent/models.json ]; then
	cp /opt/rsi/deploy/cline.models.json /data/pi-agent/models.json
	log "seeded the ClinePass model definition"
fi
if [ ! -e /data/pi-agent/auth.json ]; then
	printf '{}
' > /data/pi-agent/auth.json
	log "created empty operator auth.json"
fi
chown root:"$WORKER_GID" /data/pi-agent/settings.json /data/pi-agent/models.json /data/pi-agent/auth.json 2>/dev/null \
	|| fail "cannot make operator Pi config root-owned and Worker-group-readable"
chmod 0640 /data/pi-agent/settings.json /data/pi-agent/models.json /data/pi-agent/auth.json

# Seed the complete operator knowledge set from the immutable image copy on a
# fresh volume (or the legacy two-row index from older images). A custom
# operator-managed index is preserved untouched.
node /opt/rsi/scripts/seed-markdowns.mjs /opt/rsi/seed-markdowns /data/markdowns \
	|| fail "cannot seed managed Markdown from /opt/rsi/seed-markdowns"
chown root:root /data/markdowns/*.md 2>/dev/null || fail "cannot keep managed Markdown Supervisor-owned"
chmod 0644 /data/markdowns/*.md


umask 002
node "$RUNTIME_ROOT/scripts/deployment-render-config.mjs" --out "$CONFIG_PATH" || fail "configuration rendering failed"
node "$RUNTIME_ROOT/scripts/deployment-preflight.mjs" --config "$CONFIG_PATH" || fail "deployment preflight failed; refusing to start without a working bubblewrap sandbox"

log "starting Supervisor entry ${RSI_SUPERVISOR_ENTRY:-/opt/rsi/src/main.ts}"
exec node "$RUNTIME_ROOT/scripts/container-run.mjs"
