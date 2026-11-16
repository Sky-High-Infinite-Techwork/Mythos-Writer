# Unattended flow (Phase 1b)

Phase 1b undrafts and enqueues pull requests that already have independent evidence, and it can post a new `mythos/final-gate` success when every provider named by `MYTHOS_GATE_PROVIDERS` passes. The publisher still mirrors an existing App 5736520 head success onto a `main` queue commit whose merge tree matches. It also posts head success from an accepted reducer result. A missing, expired, or rejected credential for a listed provider, or malformed model output, is `unavailable`. That cannot pass. Codex never stands in for Claude.

These workflows do nothing until the repository variable `UNATTENDED_ENABLED` is the literal string `true`. Any other value, including a missing variable, exits without a write and without posting `mythos/final-gate`.

The switch is read again, with `MYTHOS_CONTROL_READ_TOKEN`, after every other check, including the ruleset re-read. That switch read is the last call before each undraft, enqueue, and check post. One API call that was already authorized can still finish. Turning the variable off does not cancel a merge GitHub has already accepted and does not erase a green check.

## Workflows

| Workflow | What it does in Phase 1b |
| --- | --- |
| `mythos-flow-step.yml` | Schedule and manual run from `main`. Proof is the rule below. The job undrafts a draft that has that proof and green `ci`, `notes-windows`, and `screenshot-check`, and enqueues a non-draft whose tip also has `mythos/final-gate` success from App 5736520. Enqueue is GraphQL `enqueuePullRequest` with `expectedHeadOid` set to the full tip SHA. The undraft token requests Pull requests write. The enqueue token requests Pull requests write and Merge queues write. |
| `mythos-final-gate.yml` | Schedule and manual run from `main`. Discover selects one open, non-draft, same-repo pull request to `main`. `MYTHOS_GATE_PROVIDERS` chooses which transports run. With `claude`, only the Claude job in `mythos-claude` runs, and the Codex job is skipped. Each listed transport reviews the compare of the discovered base SHA and head SHA, not the pull request's live file list. The checklist is the system prompt. The diff is only the user message and is untrusted data. A model can still be jailbroken by text inside that diff. The parent process decides pass, and it holds when the compare reports 250 or more commits, when `base_commit` or the head commit is not the discovered SHA, or when any patch is missing, binary, truncated, or over the 48,000-character cap. There are no repo instruction files and no write token. The reducer requires Critic, Shield, and Probe from each listed provider, and it holds high risk. An unlisted provider cannot fill in for a listed one. The publisher then posts `mythos/final-gate` on a `main` queue commit only when the pull request head already has that check from App 5736520 and `git merge-tree --write-tree` reproduces the queue tree. A manual `pr` input limits discovery to that pull request. |
| `mythos-automation-contracts.yml` | Pull request and merge queue. No environment and no secrets. Runs the controller tests. |

Manual runs default to `dry-run`. `act` is the mode that can write. A scheduled run is `act`, and it still stops when the variable is not `true`.

Phase 1b does not push, rebase, dispatch new work, call OpenRouter, or auto-merge `batch/**`. A pull request that touches `.github/`, auth, secrets, `electron-main/src/db.ts`, or release config stays held, including a rename out of those paths. The write App does not post PROOF comments.

`ci` (including `notes-windows`) and `screenshot-check` already run on `merge_group`.

## Proof (Phase 1a, accepted by Ivy, PM)

Phase 1a proof is required CI green from `main`'s workflow revision on the exact tip. Ivy accepted that trust level.

For each of `.github/workflows/ci.yml` and `.github/workflows/screenshot-check.yml`, the latest Actions run on that tip must have `event` `pull_request`, `status` `completed`, and `conclusion` `success`. `run.head_sha` is the tip. The run's pull request link head SHA, base ref, and base SHA match the pull request now. The workflow file blob at that tip equals the blob on `main`. A later failure, cancellation, or in-progress run on that SHA voids an earlier success. An author `PROOF @ <sha>` comment is an assertion and does not count. The write App does not post one.

`MYTHOS_FLOW_AUTHOR_ALLOWLIST` is an author allow-list. It is not a team-membership check. The value is a comma-separated list of GitHub logins, compared case-insensitively. A missing or empty variable holds every pull request. The head repository must be `Sky-High-Infinite-Techwork/Mythos-Writer`; a fork is held. An author whose login is not in the list is held. The suggested initial value is `SkyyPlayz,cursor[bot]`.

GraphQL `author.login` for a bot omits the `[bot]` suffix that REST includes (`cursor` versus `cursor[bot]`). The flow reads `author.__typename`. When that is `Bot` and the login does not already end in `[bot]`, the comparison uses `login[bot]`. A User named `cursor` does not match the allow-list entry `cursor[bot]`.

The publisher does not read `MYTHOS_FLOW_AUTHOR_ALLOWLIST`, and it cannot undraft or enqueue. It mirrors an existing trusted head gate onto a queue commit. It can also post head success when the reducer result is accepted. The reducer accepts a result only when every listed provider passes at low risk with Critic, Shield, and Probe.

A pull request is also held when the lease label list or the `main` ruleset cannot be read. `lease` and `lease:` labels match without regard to case. After the other eligibility checks, the ruleset is read again. That fresh read must still require GitHub Actions (`integration_id` 15368) on `ci`, `notes-windows`, and `screenshot-check`, the gate App (`5736520`) on `mythos/final-gate`, `strict_required_status_checks_policy` true, and a merge queue whose `merge_method` is `SQUASH`. Ruleset 25235759 on `main` is that policy. A stale or weaker ruleset holds the write. The switch is read after that ruleset re-read and is the last call before the write.

## Variables

Repository Actions variables:

| Name | Value |
| --- | --- |
| `UNATTENDED_ENABLED` | `false` until the checklist below is done. `true` arms new runs. |
| `MYTHOS_FLOW_AUTHOR_ALLOWLIST` | Author allow-list. Suggested initial value `SkyyPlayz,cursor[bot]`. Missing or empty holds every pull request. |
| `MYTHOS_WRITE_APP_ID` | `5777914` |
| `MYTHOS_WRITE_APP_INSTALLATION_ID` | `182422539` |
| `MYTHOS_GATE_APP_ID` | `5736520` |
| `MYTHOS_GATE_APP_INSTALLATION_ID` | Installation id of mythos-gate-status on Mythos-Writer |
| `MYTHOS_GATE_PROVIDERS` | `claude` for this phase. Allowed values are `claude`, `codex`, and `claude,codex`. A missing value keeps both providers required. An empty or unknown value fails closed. |

The workflows refuse a write App id or installation id other than the two numbers above.

## Environments and secrets

Each environment allows the `main` branch only. A job can use one environment, so the read token is also stored on the two environments that write.

| Environment | Secret | Used by |
| --- | --- | --- |
| `mythos-writer` | `MYTHOS_WRITE_APP_PRIVATE_KEY` | Flow-step undraft and enqueue |
| `mythos-writer` | `MYTHOS_CONTROL_READ_TOKEN` | Live switch read in that job |
| `mythos-publisher` | `MYTHOS_GATE_APP_PRIVATE_KEY` | Gate check posts |
| `mythos-publisher` | `MYTHOS_CONTROL_READ_TOKEN` | Live switch read in that job |
| `mythos-control` | `MYTHOS_CONTROL_READ_TOKEN` | Reserved for a later read-only job |
| `mythos-control` | `MYTHOS_OPS_CHECKOUT_TOKEN` | Not read by these workflows. The Phase 1 Ops controller scripts are not on Ops `main`. |
| `mythos-claude` | `CLAUDE_CODE_OAUTH_TOKEN` | Claude transport only. The Claude Code CLI is installed in that job. This is the only provider secret. |
| `mythos-codex` | none | The Codex job stays skipped while `MYTHOS_GATE_PROVIDERS` is `claude`. Do not add `OPENAI_API_KEY`. Codex on the owner's ChatGPT subscription is Phase 3, on a private self-hosted runner. |

`MYTHOS_CONTROL_READ_TOKEN` is a fine-grained PAT for Mythos-Writer with Actions variables read and metadata read. It cannot write contents or pull requests. The two App private keys stay in different environments and different jobs.

Do not add `OPENROUTER_API_KEY` or `OPENAI_API_KEY`.

## Before the switch may be set true

The environments, the write and gate App secrets, the control token, the write App's Merge queues permission, and `CLAUDE_CODE_OAUTH_TOKEN` in `mythos-claude` are already in place. That Claude token is the only provider secret.

1. Set `MYTHOS_GATE_PROVIDERS` to `claude`. Do not add `OPENAI_API_KEY`.
2. With `UNATTENDED_ENABLED` still `false`, run both privileged workflows with `workflow_dispatch` mode `dry-run`. They must exit without an undraft, enqueue, or check post.
3. Canary one pull request: set `UNATTENDED_ENABLED` to `true`, dispatch `mythos-final-gate` with mode `act` and that pull request number, and confirm a high-risk or unavailable result does not post a new head success. Then dispatch `mythos-flow-step` for that same pull request only if its tip already has the gate.
4. Leave `UNATTENDED_ENABLED` at `true` only after that canary. Scheduled runs are `act` and still stop when the variable is not `true`.

## Stop a run that is already going

1. Set `UNATTENDED_ENABLED` to `false`.
2. In the Actions tab, disable **Mythos final gate** and **Mythos flow step**, and cancel their running jobs.
3. Dequeue a pull request that is already in the queue. `ID` is the pull request node id (`gh pr view NUMBER --json id --jq .id`):

```bash
gh api graphql \
  -f query='mutation($id:ID!){ dequeuePullRequest(input:{id:$id}){ mergeQueueEntry { state } } }' \
  -f id="$ID"
```

4. If auto-merge was armed by some other tool, turn that off with `gh pr merge NUMBER --disable-auto`. That command does not merge.
5. A green `mythos/final-gate` on an old SHA stays green until a new check is posted on that SHA. Clearing one is a separate maintenance step.
6. Revoke a leaked key in the App or token settings. Deleting the Actions secret does not revoke a copy that already left GitHub.
