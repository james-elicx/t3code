# A T3 server holding one thread. The control plane starts it with internet
# access off; every HTTP(S) request leaves through the Worker's egress broker.
FROM node:24-trixie-slim

RUN apt-get update \
  && apt-get install --yes --no-install-recommends ca-certificates curl git netcat-openbsd procps \
    fuse3 s3fs \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/t3
# Native packages the server bundle leaves external, installed for this platform.
COPY runtime-package.json package.json
RUN npm install --omit=dev --no-audit --no-fund

# The Claude Code CLI the server drives. Opus 5.5, the default, needs 2.1.280 or newer.
RUN npm install --global --no-audit --no-fund @anthropic-ai/claude-code@2.1.301 \
  && claude --version

# Toolchain for the agent, matching cloudflare/vinext: Node 24 (the base image),
# pnpm 11.1.1 (its packageManager) and Vite+ 1.1.0 (its catalog).
RUN npm install --global --no-audit --no-fund pnpm@11.1.1 vite-plus@1.1.0 \
  && node --version && pnpm --version && vp --version

# System libraries Playwright's Chromium and WebKit need, the browsers
# cloudflare/vinext tests in. The browsers themselves come from the repo's own
# `playwright install`.
RUN npx --yes playwright@1.64.1 install-deps chromium webkit \
  && rm -rf /var/lib/apt/lists/* /root/.npm

# Moves directory backups between the container and R2, and mounts the shared
# bucket (with s3fs above), for the control plane. The tag matches
# @cloudflare/sandbox in package.json.
COPY --from=docker.io/cloudflare/sandbox:1.0.1 /usr/local/bin/sandbox-shim /usr/local/bin/sandbox-shim

# This branch's server bundle, staged by `vp run stage` (scripts/stage-t3.ts).
COPY t3-dist/ dist/
COPY sandbox-settings.json /opt/t3/sandbox-settings.json
COPY entrypoint.sh /usr/local/bin/t3-sandbox-entrypoint
RUN chmod +x /usr/local/bin/t3-sandbox-entrypoint \
  && mkdir -p /workspace \
  && git config --system user.name "T3 Sandbox" \
  && git config --system user.email "sandbox@t3.invalid" \
  && git config --system init.defaultBranch main

ENV T3CODE_HOME=/t3home
WORKDIR /workspace
EXPOSE 3773
ENTRYPOINT ["/usr/local/bin/t3-sandbox-entrypoint"]
