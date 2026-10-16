# A T3 server holding one thread. The control plane starts it with internet
# access off; every HTTP(S) request leaves through the Worker's egress broker.
FROM node:24-trixie-slim

RUN apt-get update \
  && apt-get install --yes --no-install-recommends ca-certificates curl git netcat-openbsd procps \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/t3
# Native packages the server bundle leaves external, installed for this platform.
COPY runtime-package.json package.json
RUN npm install --omit=dev --no-audit --no-fund

# This branch's server bundle, staged by `vp run stage` (scripts/stage-t3.ts).
COPY t3-dist/ dist/
COPY entrypoint.sh /usr/local/bin/t3-sandbox-entrypoint
RUN chmod +x /usr/local/bin/t3-sandbox-entrypoint \
  && mkdir -p /t3home /workspace \
  && git config --system user.name "T3 Sandbox" \
  && git config --system user.email "sandbox@t3.invalid" \
  && git config --system init.defaultBranch main

ENV T3CODE_HOME=/t3home
WORKDIR /workspace
EXPOSE 3773
ENTRYPOINT ["/usr/local/bin/t3-sandbox-entrypoint"]
