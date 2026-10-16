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

| Piece                     | Where                                            | What it does                                                                                                                                                                                                   |
| ------------------------- | ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sandbox API               | `src/worker.ts`                                  | `GET/POST /api/sandboxes`, `GET/DELETE /api/sandboxes/:id`, `POST …/:id/stop\|snapshot\|restore`                                                                                                               |
| One DO per sandbox        | `src/ThreadSandbox.ts`                           | Owns the session record and the container. Boots the T3 server and issues it a bearer token. Proxies `<thread-id>.<domain>` HTTP and WebSocket with that token added                                           |
| Directory                 | `src/SandboxDirectory.ts`                        | Summaries pushed by each sandbox, so clients list idle sandboxes without waking them                                                                                                                           |
| Egress                    | `src/egress/Egress.ts`                           | The only way out of a sandbox. Anything not handled below gets a 403                                                                                                                                           |
| &nbsp;&nbsp;Anthropic     | `src/egress/anthropic.ts`                        | `api.anthropic.com/v1/*` is rewritten to `gateway.ai.cloudflare.com/v1/<account>/<gateway>/anthropic/v1/*` with `cf-aig-authorization`. `x-api-key` is dropped. `ANTHROPIC_BASE_URL` is not set in the sandbox |
| &nbsp;&nbsp;GitHub        | `src/egress/githubPolicy.ts`, `githubGraphql.ts` | Read PAT for fetches and reads; write PAT only for allowed writes. Rules below                                                                                                                                 |
| &nbsp;&nbsp;git push gate | `src/egress/pktLine.ts`                          | Parses the receive-pack command list before anything reaches GitHub. A refused push gets a status report, so git prints `! [remote rejected] <ref> (<reason>)`                                                 |
| Image                     | `container/`                                     | `node:24` plus git and this branch's server bundle. T3 home is `/t3home` inside the container                                                                                                                  |
| Web client                | `wrangler.jsonc` assets                          | The `apps/web` build on the apex, with SPA fallback                                                                                                                                                            |

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
vp run --filter @t3tools/web build        # optional: the web client served on the apex
cd infra/sandbox-control
cp .dev.vars.example .dev.vars            # placeholder secrets only
vp run stage                              # copy the server bundle into container/
vp run mock                               # terminal 1: mock AI Gateway, GitHub and git (127.0.0.1:8790)
vp run dev                                # terminal 2: wrangler dev, builds the image on first start
vp run e2e                                # terminal 3: create a sandbox and run every proof
```

`vp run e2e` creates a fresh sandbox, prints PASS/FAIL with evidence for each claim, and
destroys the sandbox. Set `KEEP=1` to keep it, or `SKIP_SNAPSHOT=1` to skip snapshot and restore.
Unit tests for the parser and policies: `vp run test`.

`POST /api/sandboxes/:id/exec` runs a command in a sandbox. It exists only for these proofs and
is gated on `DEBUG_EXEC=1`.

## Not done yet

- Cloudflare Access in front of the domain, and per-user directories.
- The client side: registering sandboxes as saved environments from the directory, modeled on
  `infra/relay` discovery. Connecting lazily. A `{type:"sandbox"}` workspace strategy for
  `t3_thread_launch`. Control-plane fallbacks for thread tools across sandboxes.
- A provider CLI in the image. Claude Code still needs to be installed and checked against the
  gateway rewrite.
