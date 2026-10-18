#!/bin/sh
# Installs the checkout's dependencies (pnpm workspaces only) in the background,
# so the sandbox is usable before they are; `pnpm`, `npx` and `vp` wait for it
# (see wait-for-deps.sh).
#
#   t3-sandbox-deps sandbox <checkout>  in a thread's sandbox: starts from the
#     control plane's cache of the repo's last install when it restores one, so
#     pnpm only adds and removes what the lockfile changed since.
#   t3-sandbox-deps build <checkout>    in the control plane's cache builder:
#     installs, then moves every node_modules into the cache directory it saves.
set -u
MODE=$1
CHECKOUT=$2
STATUS=/run/t3-sandbox-deps
CACHE=/var/cache/t3-deps
RESTORED=/run/t3-sandbox-deps-restored
LOG=/var/log/t3-sandbox-deps.log
LOCKFILE="$CHECKOUT/pnpm-lock.yaml"
# The lockfile the checkout's node_modules were last installed from.
INSTALLED="$CHECKOUT/node_modules/.t3-sandbox-installed"
# Our own pnpm and its scripts' tools must not wait for this install.
export T3_SANDBOX_DEPS_INSTALLER=1

# `<state> <pid>`: the wrappers wait while the state is restoring or installing
# and this process is alive, so a snapshot taken mid-install does not wedge them.
status() { printf '%s %s\n' "$1" "$$" > "$STATUS.tmp" && mv "$STATUS.tmp" "$STATUS"; }

# Every node_modules below $1 that is not inside another, relative to $1.
modules() { (cd "$1" && find . -path ./.git -prune -o -type d -name node_modules -prune -print); }

if [ ! -f "$LOCKFILE" ]; then
  status none
  exit 0
fi
lock=$(sha256sum "$LOCKFILE" | cut -d' ' -f1)

if [ "$MODE" = sandbox ]; then
  if [ "$(cat "$INSTALLED" 2>/dev/null)" = "$lock" ]; then
    status done
    exit 0
  fi
  : > "$LOG"
  if [ ! -d "$CHECKOUT/node_modules" ] && [ -n "${T3_SANDBOX_DEPS_RESTORE:-}" ]; then
    status restoring
    # The control plane restores the cache to $CACHE meanwhile, then writes how it went.
    waited=0
    until [ -f "$RESTORED" ] || [ "$waited" -ge 9000 ]; do
      sleep 0.1
      waited=$((waited + 1))
    done
    echo "dependency cache: $(cat "$RESTORED" 2>/dev/null || echo 'timed out')" >> "$LOG"
    if [ "$(cut -d' ' -f1 "$RESTORED" 2>/dev/null)" = restored ]; then
      modules "$CACHE" | while read -r dir; do
        # A workspace package this commit no longer has gets none.
        if [ -d "$CHECKOUT/$(dirname "$dir")" ] && [ ! -e "$CHECKOUT/$dir" ]; then
          mv "$CACHE/$dir" "$CHECKOUT/$dir"
        fi
      done
      rm -rf "$CACHE"
    fi
  fi
fi

status installing
cd "$CHECKOUT" || exit 1
# Even onto a restored cache: the repo's own install scripts (builds of its
# workspace packages, say) produce files outside node_modules.
if ! pnpm install --frozen-lockfile --prefer-offline >> "$LOG" 2>&1; then
  status failed
  exit 1
fi
if [ "$MODE" = build ]; then
  rm -rf "$CACHE"
  mkdir -p "$CACHE"
  modules "$CHECKOUT" | while read -r dir; do
    mkdir -p "$CACHE/$(dirname "$dir")"
    mv "$CHECKOUT/$dir" "$CACHE/$dir"
  done
else
  printf '%s\n' "$lock" > "$INSTALLED"
fi
status done
