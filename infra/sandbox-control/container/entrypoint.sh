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

# The control plane restores the T3 home of a waking sandbox and mounts the
# shared bucket, then writes this boot's token to the marker.
if [ -n "${T3_SANDBOX_PREPARED:-}" ]; then
  waited=0
  until [ "$(cat /run/t3-sandbox-prepared 2>/dev/null)" = "$T3_SANDBOX_PREPARED" ]; do
    if [ "$waited" -ge 6000 ]; then
      echo "error: the control plane did not prepare the sandbox" >&2
      exit 1
    fi
    sleep 0.1
    waited=$((waited + 1))
  done
fi

# Every step below is skipped when a restore or snapshot already did it.
T3_HOME="${T3CODE_HOME:-/t3home}"
# A new sandbox starts with the control plane's settings template (the last
# settings edited in any sandbox), or the image's defaults before there is one.
if [ ! -f "$T3_HOME/userdata/settings.json" ]; then
  mkdir -p "$T3_HOME/userdata"
  if [ -n "${T3_SANDBOX_SETTINGS:-}" ]; then
    printf '%s' "$T3_SANDBOX_SETTINGS" > "$T3_HOME/userdata/settings.json"
  else
    cp /opt/t3/sandbox-settings.json "$T3_HOME/userdata/settings.json"
  fi
fi

# The control plane picks the environment id before the sandbox first runs, so
# clients can show its project and first thread while it boots.
if [ -n "${T3_SANDBOX_ENVIRONMENT_ID:-}" ] && [ ! -s "$T3_HOME/userdata/environment-id" ]; then
  printf '%s\n' "$T3_SANDBOX_ENVIRONMENT_ID" > "$T3_HOME/userdata/environment-id"
fi

# Shared skills and memories, read-only at /shared: Claude loads the skills and
# imports the memory index, then reads the memories it links as it needs them.
# A skills directory the sandbox made itself is left alone.
CLAUDE_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
mkdir -p "$CLAUDE_DIR"
if [ -d /shared/skills ] && { [ -L "$CLAUDE_DIR/skills" ] || [ ! -e "$CLAUDE_DIR/skills" ]; }; then
  ln -sfn /shared/skills "$CLAUDE_DIR/skills"
fi
if [ -f /shared/memories/MEMORY.md ] && ! grep -qsF "@/shared/memories/MEMORY.md" "$CLAUDE_DIR/CLAUDE.md"; then
  printf '\n# Shared memories (read-only)\n@/shared/memories/MEMORY.md\n' >> "$CLAUDE_DIR/CLAUDE.md"
fi

# The session repo, cloned through the egress broker. Work happens on the
# sandbox's own branch, the only one it may push; a sandbox whose snapshot is
# gone picks up from what it pushed there.
: "${T3_SANDBOX_REPO:?T3_SANDBOX_REPO is required (owner/name)}"
CHECKOUT="/workspace/${T3_SANDBOX_REPO#*/}"
if [ ! -d "$CHECKOUT/.git" ]; then
  if ! git clone --quiet "https://github.com/$T3_SANDBOX_REPO.git" "$CHECKOUT"; then
    echo "error: could not clone $T3_SANDBOX_REPO" >&2
    exit 1
  fi
  if [ -n "${T3_SANDBOX_BRANCH:-}" ]; then
    if git -C "$CHECKOUT" rev-parse --quiet --verify "refs/remotes/origin/$T3_SANDBOX_BRANCH" >/dev/null; then
      git -C "$CHECKOUT" checkout --quiet "$T3_SANDBOX_BRANCH"
    else
      git -C "$CHECKOUT" checkout --quiet -b "$T3_SANDBOX_BRANCH"
    fi
  fi
fi

# A container that is booting runs no server; a restored home may still hold
# the last one's runtime file, whose pid (1) would read as alive.
rm -f "$T3_HOME/userdata/server-runtime.json"

# The control plane creates the checkout's project itself (with an id derived
# from the repo), so T3 does not bootstrap one with an empty thread.
cd "$CHECKOUT"
export T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD=false
exec node /opt/t3/dist/bin.mjs start \
  --host 0.0.0.0 \
  --port 3773 \
  --base-dir "$T3_HOME" \
  --no-browser
