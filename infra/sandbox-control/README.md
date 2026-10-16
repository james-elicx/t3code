# Sandbox control plane (proof of concept)

> [!WARNING]
> Local proof of concept. It has not been deployed, and nothing here talks to a real
> Cloudflare account, AI Gateway, or GitHub.

Runs each T3 thread in its own [Cloudflare Sandbox](https://developers.cloudflare.com/sandbox/).
Each sandbox is a container running a full T3 server that holds that one thread. A Worker in
front owns everything that needs trust: the sandbox API, the proxy into each sandbox, and every
request a sandbox makes to the outside.

**No credential lives in a sandbox.** It holds placeholder keys. Its internet access is off,
and every HTTP(S) request it makes is intercepted by the Worker's `Egress` entrypoint. That
entrypoint applies policy and adds the real credential outside the sandbox.

## How it fits together

| Piece                     | Where                                             | What it does                                                                                                                                                                                                   |
| ------------------------- | ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sandbox API               | `src/worker.ts`                                   | `GET/POST /api/sandboxes`, `GET/DELETE /api/sandboxes/:id`, `POST …/:id/stop\|snapshot\|restore`                                                                                                               |
| One DO per sandbox        | `src/ThreadSandbox.ts`                            | Owns the session record and the container. Boots the T3 server and issues it a bearer token. Proxies `<thread-id>.<domain>` HTTP and WebSocket with that token added                                           |
| Directory                 | `src/SandboxDirectory.ts`                         | Summaries pushed by each sandbox, so clients list idle sandboxes without waking them                                                                                                                           |
| Egress                    | `src/egress/Egress.ts`                            | The only way out of a sandbox. Anything not handled below gets a 403                                                                                                                                           |
| &nbsp;&nbsp;Anthropic     | `src/egress/anthropic.ts`                         | `api.anthropic.com/v1/*` is rewritten to `gateway.ai.cloudflare.com/v1/<account>/<gateway>/anthropic/v1/*` with `cf-aig-authorization`. `x-api-key` is dropped. `ANTHROPIC_BASE_URL` is not set in the sandbox |
| &nbsp;&nbsp;GitHub        | `src/egress/githubPolicy.ts`, `githubGraphql.ts`  | Read PAT for fetches and reads; write PAT only for allowed writes. Rules below                                                                                                                                 |
| &nbsp;&nbsp;git push gate | `src/egress/pktLine.ts`                           | Parses the receive-pack command list before anything reaches GitHub. A refused push gets a status report, so git prints `! [remote rejected] <ref> (<reason>)`                                                 |
| Image                     | `container/`                                      | `node:24`, git, Claude Code and this branch's server bundle. Boots by cloning the repo and starting T3 on it. T3 home is `/t3home` inside the container                                                        |
| Web client                | `wrangler.jsonc` assets, `apps/web/src/sandboxes` | `apps/web` built in sandbox mode on the apex, with SPA fallback. See below                                                                                                                                     |

GitHub rules, all relative to the session (`repo`, `baseBranch`, and branch prefix `t3/<thread-id>/`):

- **Pushes:** only to `refs/heads/t3/<thread-id>/…`. Tags, other branches, the base branch, and other repos are refused.
- **Creating a PR:** `POST /pulls` needs head to be a session branch and base to be the session base. The PR number and node ID are recorded on the session.
- **Changing a PR:** `PATCH`, comments, reviews, reviewers and update-branch are allowed only on recorded PRs. Changing a PR's `base` is refused.
- **Merges:** always refused, through REST, `/merges`, and the `mergePullRequest`, `enablePullRequestAutoMerge` and `mergeBranch` mutations.
- **GraphQL:** queries pass with the read PAT. A mutation must match one of T3's own mutation documents exactly, and its node ID must be a recorded PR. `githubGraphql.test.ts` fails if T3's documents drift.

## Run it locally

You need Docker running.

```sh
vp i
vp run --filter t3 build                  # the server bundle the image runs
cd infra/sandbox-control
cp .dev.vars.example .dev.vars            # placeholder secrets only
vp run stage                              # copy the server bundle into container/
vp run build:web                          # the web client in sandbox mode, served on the apex
vp run mock                               # terminal 1: mock AI Gateway, GitHub and git (127.0.0.1:8790)
vp run dev                                # terminal 2: wrangler dev, builds the image on first start
```

Open http://localhost:8787, enter `acme/demo` (the mock's only repository) and start a thread. The
sandbox clones the repo onto `t3/<thread-id>/work`, and T3 opens its one thread with Claude Code
(Opus 5.5) as the agent. The mock gateway answers every model request with a short streamed reply.

Two test suites run against the running control plane:

- `vp run e2e` creates a sandbox and proves each control-plane claim with shell-level evidence,
  including a `claude -p` turn through the gateway rewrite. It prints PASS/FAIL per claim and
  destroys the sandbox. Set `KEEP=1` to keep it, or `SKIP_SNAPSHOT=1` to skip snapshot and restore.
- `vp run e2e:ui` drives the web client in headless Chromium: start a sandbox thread from the
  landing page and chat, start a second one with "New thread", reload, and delete one from the
  command palette. It checks the mock's records to confirm Claude's own request went through the
  egress proxy. Set `BASE_URL` to run it against a deployed domain; the mock checks are skipped when
  `MOCK_URL` is unreachable. It deletes the sandboxes it started unless `KEEP=1`.

Unit tests for the parser and policies: `vp run test`.

`POST /api/sandboxes/:id/exec` runs a command in a sandbox. It exists only for these proofs and
is gated on `DEBUG_EXEC=1`.

## The web client in sandbox mode

`build:web` builds `apps/web` as a hosted app (`VITE_HOSTED_APP_URL`) with
`VITE_SANDBOX_DIRECTORY_URL=/api/sandboxes`. Only with both set does the client switch to sandbox
mode, so other builds are unchanged. In sandbox mode:

- Each sandbox in the directory that has booted is a platform environment at its own origin. The
  browser holds a placeholder token; the proxy replaces it with the sandbox's credential.
- The landing page, "New sandbox thread" in the command palette, and "New thread" on a sandbox
  project all start a thread in a new sandbox. One sandbox holds one thread.
- "Delete this thread's sandbox" in the command palette is the way out.

## Deploying to a test account

Not done yet. Ask before deploying: it runs containers on a real account. You will need:

- **A custom domain.** Each sandbox is served at `<thread-id>.<domain>`, and workers.dev has no
  wildcard subdomains. Route both the apex and `*.<apex>` to the Worker, and set `SANDBOX_DOMAIN`
  to the apex.
- **Cloudflare Access on both routes.** Anyone who reaches the domain gets admin on every sandbox:
  the proxy adds each sandbox's credential for them.
- **The web build for that origin:** `SANDBOX_APP_URL=https://<apex> vp run build:web`.
- **Real upstreams.** Set `AI_GATEWAY_BASE_URL` to
  `https://gateway.ai.cloudflare.com/v1/<account>/<gateway>`, `GITHUB_ORIGIN` to
  `https://github.com` and `GITHUB_API_ORIGIN` to `https://api.github.com`. Set `DEBUG_EXEC` to
  `0`. Then `wrangler secret put` `AI_GATEWAY_TOKEN`, `GITHUB_WRITE_PAT` and `GITHUB_READ_PAT`.
  The gateway needs an Anthropic key stored in it (BYOK). The read PAT needs read access to the
  repos you will test with.

## Not done yet

- Cloudflare Access in front of the domain, and per-user directories.
- Desktop and mobile clients, and a `{type:"sandbox"}` workspace strategy for `t3_thread_launch`.
  Thread tools don't reach across sandboxes.
- Claude Code is the only provider in the image.
