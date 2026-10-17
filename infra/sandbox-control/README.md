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
| Sandbox API               | `src/worker.ts`                                         | `GET/POST /api/sandboxes`, `GET/DELETE /api/sandboxes/:id`, `POST …/:id/wake\|sleep`                                                                                                                                     |
| One DO per sandbox        | `src/ThreadSandbox.ts`                                  | Owns the session record and the container. Boots the T3 server, issues it a bearer token, creates its project. Proxies `/s/<thread-id>/…` with that token added. Sleeps and wakes it (below)                             |
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
vp run mock                               # terminal 1: mock AI Gateway, GitHub, git and S3 (127.0.0.1:8790, :8791)
vp run dev                                # terminal 2: cf dev, builds the image on first start
```

Open http://localhost:8787, enter `acme/demo` (the mock's only repository) and start a thread. The
sandbox clones the repo onto `t3/<thread-id>/work`, and T3 opens its one thread with Claude Code
(Opus 5.5) as the agent. The mock gateway answers every model request with a short streamed reply.

Two test suites run against the running control plane:

- `vp run e2e` creates a sandbox and proves each control-plane claim with shell-level evidence,
  including a `claude -p` turn through the gateway rewrite. It prints PASS/FAIL per claim and
  destroys the sandbox. Set `KEEP=1` to keep it.
- `vp run e2e:ui` drives the web client in headless Chromium: start a sandbox from a repository and
  chat, start a second thread from it (the toggle sends it to a new sandbox), put a sandbox to sleep
  and reopen its thread, and delete a thread with its sandbox. It also covers a repository that
  does not clone, cancelling a sandbox's setup, and a fresh browser listing an asleep sandbox's
  thread. It checks the mock's records to confirm Claude's own request went through the
  egress proxy. Set `BASE_URL` to run it against a deployment (see below); the mock checks are skipped when
  `MOCK_URL` is unreachable. It deletes the sandboxes it started unless `KEEP=1`.

Unit tests for the parser and policies: `vp run test`.

`POST /api/sandboxes/:id/exec` runs a command in a sandbox, and `POST …/:id/forget-snapshot`
makes the next wake ignore its snapshot. They exist only for these proofs and are gated on
`DEBUG_EXEC=1`.

## Sleeping and waking

A sandbox keeps its disk until it is deleted, without running all the time:

- **Awake while there is work.** An alarm checks the T3 server's thread list every minute. While a
  thread is unsettled, has a live run or background tasks, or a client has called `/wake` in the
  last 10 minutes, the sandbox stays up. Clients call `/wake` when they open the thread and every
  minute while it stays open.
- **Then asleep.** It backs up the T3 home (T3's database, settings, Claude's transcripts in
  `CLAUDE_CONFIG_DIR=/t3home/claude`) to R2 with `DirectoryBackup`, snapshots the container's
  disk (the checkout, uncommitted work, installed dependencies), and stops. While asleep, proxied
  requests get `503 {"status":"asleep"}` and do not wake it: clients ping every environment they
  know, so only `/wake` boots one.
- **Waking.** The container starts from its snapshot and the T3 home is restored from R2 before T3
  starts. Snapshots expire after 30 days and belong to one image. Without a usable one, the sandbox
  starts from the image, restores the T3 home, clones the repo and checks out the session branch
  it pushed. Uncommitted work is lost on that path; history and settings are not.
- **Checkpoints.** An awake sandbox saves the same way every 30 minutes when its egress shows the
  agent working, so a host restart loses at most that much. A sandbox whose container died while
  awake is restarted from its last save.
- **Deleting** the sandbox deletes its R2 objects. Its snapshot cannot be deleted and expires.

**Settings.** A new sandbox starts with the last T3 settings edited in any sandbox, from any client
or by an agent. The lifecycle alarm notices the change in that sandbox's `settings.json` and stores
it in `SandboxDirectory` as the template. Sandboxes that already exist keep their own settings.
Before any edit, new sandboxes use `container/sandbox-settings.json`. Secrets are not in that file:
T3 keeps them under `secrets/`.

Locally `SLEEP_AFTER_MS` is 20 seconds and the alarm runs every 5, so the proofs can watch it.

## Shared skills and memories

Every sandbox mounts one R2 bucket, `t3-sandbox-control-shared`, read-only at `/shared` with
`S3Mount`. The bucket holds:

```
skills/<name>/SKILL.md      Claude Code skills, one directory each
memories/MEMORY.md          the memory index, one line per memory linking its file
memories/<memory>.md
```

The entrypoint links `/shared/skills` as Claude's skills directory (unless the sandbox has made its
own) and imports `@/shared/memories/MEMORY.md` from Claude's `CLAUDE.md`; Claude reads the linked
memories as it needs them. Objects added to the bucket show up in running sandboxes.

The Worker signs the bucket's requests, so its keys never enter a sandbox. `S3Mount` registers its
route after the catch-all egress intercept, which takes it, so `Egress` hands
`s3-*.sandbox.internal` to `S3Gateway` itself (`src/sharedMount.ts`). Snapshots leave mounts out;
every boot mounts the bucket again. Without `SHARED_S3_ENDPOINT` and both keys there is no mount,
and a failed mount leaves the sandbox up without it. Locally the mock serves a seeded bucket.

## The web client in sandbox mode

`build:web` builds `apps/web` as a hosted app (`VITE_HOSTED_APP_URL`) with
`VITE_SANDBOX_DIRECTORY_URL=/api/sandboxes`. Only with both set does the client switch to sandbox
mode, so other builds are unchanged. In sandbox mode:

- Each sandbox in the directory that has booted is a platform environment at `/s/<thread-id>` on
  the same origin. The browser holds a placeholder token; the proxy replaces it with the sandbox's
  credential.
- New threads use the normal draft. The composer's sandbox toggle decides where the first message
  goes: off, to the machine the draft is on (a computer you pair in Connections); on, to a new
  sandbox for the project's GitHub repository (a fork's own remote). The draft waits in the
  composer while the sandbox starts, then moves into the sandbox's project and sends. One sandbox
  holds one thread, so a draft in a sandbox that has its thread can only start another. The toggle
  is a size picker with one size today (`SANDBOX_INSTANCES`).
- "Start from a GitHub repo…" in the command palette (and the landing page before any sandbox or
  computer exists) starts a sandbox for a repository none of your machines has, then opens a draft
  in it.
- Opening a thread calls `/wake` and shows "Waking the sandbox…" until it runs; the transcript
  reads from the browser's cache meanwhile. A browser that has never seen a sandbox wakes it once
  to list its thread.
- Deleting the thread deletes its sandbox, asleep or not.

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

   For shared skills and memories, create the R2 bucket `t3-sandbox-control-shared` and an R2 API
   token with Object Read only, scoped to it. Add its keys to the secrets file as
   `SHARED_S3_ACCESS_KEY_ID` and `SHARED_S3_SECRET_ACCESS_KEY`, and add
   `SANDBOX_SHARED_S3_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com` to the deploy
   command. Without them, sandboxes have no `/shared`. Fill the bucket with
   `wrangler r2 object put t3-sandbox-control-shared/<key> --file <file> --remote`.

   The R2 bucket `t3-sandbox-control-backups` must exist in the Worker's account. Give it a
   lifecycle rule that aborts incomplete multipart uploads after a day: a backup interrupted by a
   restart leaves one behind.

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
