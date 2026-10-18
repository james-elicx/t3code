#!/bin/sh
# Installed as pnpm, npx and vp ahead of the real ones on PATH: waits for the
# sandbox's background dependency install (see deps.sh), then runs the real
# command, so nothing an agent runs sees half-installed node_modules.
STATUS=/run/t3-sandbox-deps
LOG=/var/log/t3-sandbox-deps.log
# Alive and not a zombie: T3, PID 1, does not reap the install it inherits.
alive() { case "$(ps -o stat= -p "$1" 2>/dev/null)" in "" | Z*) false ;; *) true ;; esac; }
if [ -z "${T3_SANDBOX_DEPS_INSTALLER:-}" ]; then
  announced=
  while read -r state pid 2>/dev/null < "$STATUS" &&
    { [ "$state" = restoring ] || [ "$state" = installing ]; } &&
    alive "$pid"; do
    if [ -z "$announced" ]; then
      echo "Waiting for the sandbox to finish installing dependencies (log: $LOG)..." >&2
      announced=1
    fi
    sleep 1
  done
  if [ "${state:-}" = failed ]; then
    echo "The sandbox's dependency install failed; see $LOG." >&2
  fi
fi
name=$(basename "$0")
here=$(dirname "$0")
PATH=$(printf '%s' "$PATH" | sed "s#^$here:##; s#:$here:#:#g; s#:$here\$##")
exec "$name" "$@"
