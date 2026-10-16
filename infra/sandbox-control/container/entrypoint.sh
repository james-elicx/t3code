#!/bin/sh
set -eu

# HTTPS interception re-signs traffic with a per-instance CA. Add it to the
# system store so git, curl and the Claude CLI trust it; Node also reads
# NODE_EXTRA_CA_CERTS, which the control plane sets.
CA=/etc/cloudflare/certs/cloudflare-containers-ca.crt
if [ -f "$CA" ]; then
  cp "$CA" /usr/local/share/ca-certificates/cloudflare-containers-ca.crt
  update-ca-certificates >/dev/null 2>&1 || echo "warning: could not update CA store" >&2
fi

# T3 home lives inside the container, so a snapshot carries the thread with it.
# Every step below is skipped when a restored snapshot already did it.
T3_HOME="${T3CODE_HOME:-/t3home}"
if [ ! -f "$T3_HOME/userdata/settings.json" ]; then
  mkdir -p "$T3_HOME/userdata"
  cp /opt/t3/sandbox-settings.json "$T3_HOME/userdata/settings.json"
fi

# The session repo, cloned through the egress broker with the read credential.
# Work starts on the sandbox's own branch, the only one it may push.
: "${T3_SANDBOX_REPO:?T3_SANDBOX_REPO is required (owner/name)}"
CHECKOUT="/workspace/${T3_SANDBOX_REPO#*/}"
if [ ! -d "$CHECKOUT/.git" ]; then
  if ! git clone --quiet "https://github.com/$T3_SANDBOX_REPO.git" "$CHECKOUT"; then
    echo "error: could not clone $T3_SANDBOX_REPO" >&2
    exit 1
  fi
  if [ -n "${T3_SANDBOX_BRANCH:-}" ]; then
    git -C "$CHECKOUT" checkout --quiet -b "$T3_SANDBOX_BRANCH"
  fi
fi

# A container that is booting runs no server; a restored snapshot may still
# hold the last one's runtime file, whose pid (1) would read as alive.
rm -f "$T3_HOME/userdata/server-runtime.json"

# `start` (not `serve`, which turns it off) creates the checkout's project and
# its one thread on first start.
cd "$CHECKOUT"
exec node /opt/t3/dist/bin.mjs start \
  --host 0.0.0.0 \
  --port 3773 \
  --base-dir "$T3_HOME" \
  --no-browser \
  --auto-bootstrap-project-from-cwd
