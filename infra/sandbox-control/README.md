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

| Piece                     | Where                                                   | What it does                                                                                                                                                                                                             |
| ------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Sandbox API               | `src/worker.ts`                                         | `GET/POST /api/sandboxes`, `GET/DELETE /api/sandboxes/:id`, `POST …/:id/stop\|snapshot\|restore`                                                                                                                         |
| One DO per sandbox        | `src/ThreadSandbox.ts`                                  | Owns the session record and the container. Boots the T3 server and issues it a bearer token. Proxies `/s/<thread-id>/…` HTTP and WebSocket with that token added                                                         |
| Directory                 | `src/SandboxDirectory.ts`                               | Summaries pushed by each sandbox, so clients list idle sandboxes without waking them                                                                                                                                     |
| Egress                    | `src/egress/Egress.ts`                                  | The only way out of a sandbox. Anthropic and GitHub get the handling below; any other host is fetched as asked, since the sandbox holds nothing to protect. Raw TCP is off                                               |
| &nbsp;&nbsp;Anthropic     | `src/egress/anthropic.ts`                               | `api.anthropic.com/v1/*` is rewritten to `gateway.ai.cloudflare.com/v1/<account>/<gateway>/anthropic/v1/*` with `cf-aig-authorization`. `x-api-key` is dropped. `ANTHROPIC_BASE_URL` is not set in the sandbox           |
| &nbsp;&nbsp;GitHub        | `src/egress/githubPolicy.ts`, `githubGraphql.ts`        | Read PAT for fetches and reads; write PAT only for allowed writes. Rules below                                                                                                                                           |
| &nbsp;&nbsp;git push gate | `src/egress/pktLine.ts`                                 | Parses the receive-pack command list before anything reaches GitHub. A refused push gets a status report, so git prints `! [remote rejected] <ref> (<reason>)`                                                           |
| Image                     | `container/`                                            | Node 24, pnpm 11.1.1 and Vite+ 1.1.0 (the versions cloudflare/vinext uses), git, Claude Code and this branch's server bundle. Boots by cloning the repo and starting T3 on it. T3 home is `/t3home` inside the container |
| Web client                | `cloudflare.config.ts` assets, `apps/web/src/sandboxes` | `apps/web` built in sandbox mode, served from `/` with SPA fallback. See below                                                                                                                                           |

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
vp run build:web                          # the web client in sandbox mode, served from /
vp run mock                               # terminal 1: mock AI Gateway, GitHub and git (127.0.0.1:8790)
vp run dev                                # terminal 2: cf dev, builds the image on first start
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
  egress proxy. Set `BASE_URL` to run it against a deployment (see below); the mock checks are skipped when
  `MOCK_URL` is unreachable. It deletes the sandboxes it started unless `KEEP=1`.

Unit tests for the parser and policies: `vp run test`.

`POST /api/sandboxes/:id/exec` runs a command in a sandbox. It exists only for these proofs and
is gated on `DEBUG_EXEC=1`.

## The web client in sandbox mode

`build:web` builds `apps/web` as a hosted app (`VITE_HOSTED_APP_URL`) with
`VITE_SANDBOX_DIRECTORY_URL=/api/sandboxes`. Only with both set does the client switch to sandbox
mode, so other builds are unchanged. In sandbox mode:

- Each sandbox in the directory that has booted is a platform environment at `/s/<thread-id>` on
  the same origin. The browser holds a placeholder token; the proxy replaces it with the sandbox's
  credential.
- The landing page, "New sandbox thread" in the command palette, and "New thread" on a sandbox
  project all start a thread in a new sandbox. One sandbox holds one thread.
- "Delete this thread's sandbox" in the command palette is the way out.

## Configuration

`cloudflare.config.ts` is the whole Worker config, read by the `cf` CLI (`cf dev`, `cf build`,
`cf deploy`). `wrangler.config.ts` holds the bundler's settings: the assets directory and the dev
port. Without a mode, every upstream is the mock and the secrets come from `.dev.vars`. `--mode
test` is a deployed Worker, configured from the environment.

Everything is served from one hostname, so it works on workers.dev, which has no wildcard
subdomains. A sandbox lives at `/s/<thread-id>/…`, and the Worker strips that prefix before
proxying. One origin also keeps Cloudflare Access simple: one application, one cookie, and no
cross-origin preflights, which Access would refuse.

The Durable Objects are reached through `ctx.exports`, not bindings. `cf` gives every Durable
Object binding a `script_name`, and Wrangler refuses to attach a container to a Durable Object
bound that way.

## Deploying to a test account

Not done yet. Ask before deploying: it runs containers on a real account.

The Worker refuses every request until Cloudflare Access is configured. Without
`ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` it serves loopback hosts only. With them, it verifies the
`Cf-Access-Jwt-Assertion` token on every request itself, so a missing or loosened Access policy
fails closed. (`ctx.access` would do this, but Workers with static assets do not receive it.) The
Access cookie and token are removed before a request reaches a sandbox. This matters: anyone the
Worker lets through gets admin on every sandbox, because the proxy adds each sandbox's credential
for them.

1. **AI Gateway and GitHub.** Create a gateway with an Anthropic key stored in it (BYOK), with
   authentication on. It can be in a different account from the Worker; `AI_GATEWAY_TOKEN` is that
   gateway's token. Create a
   write PAT for pushes and PRs. A read PAT is optional: without one, the session repository is
   fetched anonymously, so only public repos work.
2. **The web build for the workers.dev origin:**
   `SANDBOX_APP_URL=https://t3-sandbox-control.<subdomain>.workers.dev vp run build:web`.
3. **Deploy.** Put `AI_GATEWAY_TOKEN`, `GITHUB_WRITE_PAT` and `GITHUB_READ_PAT` in a secrets file
   outside the repo, then:

   ```sh
   CLOUDFLARE_ACCOUNT_ID=<worker account> \
   SANDBOX_AI_GATEWAY_URL=https://gateway.ai.cloudflare.com/v1/<gateway account>/<gateway> \
     vp run deploy:test --secrets-file <file>
   ```

   Leave `GITHUB_READ_PAT` empty to go without one. `DEBUG_EXEC` is off.

4. **Cloudflare Access.** In Zero Trust, add a self-hosted application for the hostname
   `t3-sandbox-control.<subdomain>.workers.dev`, with an Allow policy for the people who should
   use it. Use a hostname application, not the Worker's "Protect this Worker behind Access"
   toggle: Worker-level Access rejects WebSocket upgrades, and the client talks to each sandbox
   over a WebSocket. Version preview URLs are off in the config, so the workers.dev hostname is
   the only one.
5. **Point the Worker at that application.** Copy the application's AUD tag and the team domain,
   then deploy again with
   `SANDBOX_ACCESS_TEAM_DOMAIN=https://<team>.cloudflareaccess.com SANDBOX_ACCESS_AUD=<aud>` added.

To run `e2e:ui` against the deployment, create a service token, add a Service Auth policy for it to
the application, and set `BASE_URL`, `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET`. The mock
checks are skipped there. `e2e` needs `DEBUG_EXEC=1`, so it is local only.

## Not done yet

- Per-user directories: everyone Access lets in sees every sandbox.
- Desktop and mobile clients, and a `{type:"sandbox"}` workspace strategy for `t3_thread_launch`.
  Thread tools don't reach across sandboxes.
- Claude Code is the only provider in the image.
