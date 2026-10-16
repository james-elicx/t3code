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
exec node /opt/t3/dist/bin.mjs serve \
  --host 0.0.0.0 \
  --port 3773 \
  --base-dir "${T3CODE_HOME:-/t3home}" \
  --no-browser
