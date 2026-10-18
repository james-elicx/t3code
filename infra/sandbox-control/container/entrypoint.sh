#!/bin/sh
set -eu

# When each step finished (ms since the epoch), for the control plane's boot log.
mark() { printf '%s %s\n' "$1" "$(date +%s%3N)" >> /run/t3-sandbox-timing; }
: > /run/t3-sandbox-timing
mark start

# HTTPS interception re-signs traffic with a per-instance CA. Add it to the
# system bundle so git, curl and the Claude CLI trust it; Node also reads
# NODE_EXTRA_CA_CERTS, which the control plane sets. The bundle is the image's
# plus this instance's CA, rather than update-ca-certificates rebuilding the
# whole store (16 s on half a vCPU). The CA is also left where a later rebuild
# of the store, say by an apt install, picks it up.
CA=/etc/cloudflare/certs/cloudflare-containers-ca.crt
BUNDLE=/etc/ssl/certs/ca-certificates.crt
if [ -f "$CA" ]; then
  cp "$CA" /usr/local/share/ca-certificates/cloudflare-containers-ca.crt
  [ -f "$BUNDLE.image" ] || cp "$BUNDLE" "$BUNDLE.image"
  cat "$BUNDLE.image" "$CA" > "$BUNDLE"
fi
mark ca

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
mark prepared

# The control plane's dependency cache builder: the default branch, installed
# and left in /var/cache/t3-deps for the control plane to save (see deps.sh).
# It runs no T3 server and no agent.
if [ -n "${T3_SANDBOX_DEPS_BUILD:-}" ]; then
  CHECKOUT="/workspace/${T3_SANDBOX_REPO#*/}"
  if ! git clone --quiet --depth 1 "https://github.com/$T3_SANDBOX_REPO.git" "$CHECKOUT"; then
    echo "error: could not clone $T3_SANDBOX_REPO" >&2
    exit 1
  fi
  t3-sandbox-deps build "$CHECKOUT"
  exec sleep infinity
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
if ! grep -qsF /run/t3-sandbox-deps "$CLAUDE_DIR/CLAUDE.md"; then
  cat >> "$CLAUDE_DIR/CLAUDE.md" <<'NOTE'

# Dependencies
The sandbox installs the checkout's dependencies in the background when it
starts, and pnpm, npx and vp wait for that install to finish. Its state is in
/run/t3-sandbox-deps and its log in /var/log/t3-sandbox-deps.log.
NOTE
fi

# The session repo, cloned through the egress broker. Work happens on the
# sandbox's own branch, the only one it may push; a sandbox whose snapshot is
# gone picks up from what it pushed there. The clone is shallow: indexing the
# full history of a large repo is most of a minute on half a vCPU, so history
# and the other branches arrive in the background, below T3 in priority. A
# probe (booted only to read T3's server config) has no repository.
if [ -n "${T3_SANDBOX_PROBE:-}" ]; then
  CHECKOUT=/workspace/probe
  mkdir -p "$CHECKOUT"
else
  : "${T3_SANDBOX_REPO:?T3_SANDBOX_REPO is required (owner/name)}"
  CHECKOUT="/workspace/${T3_SANDBOX_REPO#*/}"
  if [ ! -d "$CHECKOUT/.git" ]; then
    if ! git clone --quiet --depth 1 "https://github.com/$T3_SANDBOX_REPO.git" "$CHECKOUT"; then
      echo "error: could not clone $T3_SANDBOX_REPO" >&2
      exit 1
    fi
    mark clone
    # A shallow clone tracks only the default branch; track them all, as a full one does.
    git -C "$CHECKOUT" config remote.origin.fetch "+refs/heads/*:refs/remotes/origin/*"
    if [ -n "${T3_SANDBOX_BRANCH:-}" ]; then
      if git -C "$CHECKOUT" fetch --quiet --depth 1 origin \
        "refs/heads/$T3_SANDBOX_BRANCH:refs/remotes/origin/$T3_SANDBOX_BRANCH" 2>/dev/null; then
        git -C "$CHECKOUT" checkout --quiet "$T3_SANDBOX_BRANCH"
      else
        git -C "$CHECKOUT" checkout --quiet -b "$T3_SANDBOX_BRANCH"
      fi
      mark branch
    fi
  fi
  # History and dependencies arrive in the background, once T3 answers: on half
  # a vCPU, their disk writes alone made T3 take a minute to start. Until then
  # the status says installing, so pnpm, npx and vp wait (see deps.sh).
  (
    until curl -fs -o /dev/null http://127.0.0.1:3773/.well-known/t3/environment; do sleep 1; done
    # Also when a snapshot caught the checkout before its history arrived.
    if [ -f "$CHECKOUT/.git/shallow" ]; then
      nice -n 19 git -C "$CHECKOUT" fetch --quiet --unshallow origin \
        > /var/log/t3-sandbox-history.log 2>&1 &
    fi
    nice -n 10 t3-sandbox-deps sandbox "$CHECKOUT" > /dev/null 2>&1
  ) &
  printf 'installing %s\n' "$!" > /run/t3-sandbox-deps
fi

# A container that is booting runs no server; a restored home may still hold
# the last one's runtime file, whose pid (1) would read as alive.
rm -f "$T3_HOME/userdata/server-runtime.json"

# The control plane creates the checkout's project itself (with an id derived
# from the repo), so T3 does not bootstrap one with an empty thread.
cd "$CHECKOUT"
export T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD=false
mark t3
exec node /opt/t3/dist/bin.mjs start \
  --host 0.0.0.0 \
  --port 3773 \
  --base-dir "$T3_HOME" \
  --no-browser
