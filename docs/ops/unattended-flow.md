# Unattended flow (Phase 1a)

Phase 1a undrafts and enqueues pull requests that already have independent evidence. It does not run a model review, and it does not post a new `mythos/final-gate` success on a pull request tip. The publisher mirrors an existing App 5736520 head success onto a `main` queue commit whose merge tree matches. The same job can post head success from an accepted reducer result. Phase 1a transports are unavailable, so the reducer cannot pass and that head post does not run.

These workflows do nothing until the repository variable `UNATTENDED_ENABLED` is the literal string `true`. Any other value, including a missing variable, exits without a write and without posting `mythos/final-gate`.

The switch is read again, with `MYTHOS_CONTROL_READ_TOKEN`, after every other check, including the ruleset re-read. That switch read is the last call before each undraft, enqueue, and check post. One API call that was already authorized can still finish. Turning the variable off does not cancel a merge GitHub has already accepted and does not erase a green check.

## Workflows

| Workflow | What it does in Phase 1a |
| --- | --- |
| `mythos-flow-step.yml` | Schedule and manual run from `main`. Proof is the Phase 1a rule below. The job undrafts a draft that has that proof and green `ci`, `notes-windows`, and `screenshot-check`, and enqueues a non-draft whose tip also has `mythos/final-gate` success from App 5736520. Enqueue is GraphQL `enqueuePullRequest` with `expectedHeadOid` set to the full tip SHA. The token requests Pull requests write only. |
| `mythos-final-gate.yml` | Schedule and manual run from `main`. Discover selects no head. Claude and Codex emit unavailable and call no model, so the reducer cannot pass and this workflow does not create a tip gate. The publisher, in a separate job, posts `mythos/final-gate` on a `main` queue commit only when the pull request head already has that check from App 5736520 and `git merge-tree --write-tree` reproduces the queue tree. A manual `pr` input limits that scan to one pull request. |
| `mythos-automation-contracts.yml` | Pull request and merge queue. No environment and no secrets. Runs the controller tests. |

Manual runs default to `dry-run`. `act` is the mode that can write. A scheduled run is `act`, and it still stops when the variable is not `true`.

Phase 1a does not push, rebase, dispatch new work, call OpenRouter, or auto-merge `batch/**`. A pull request that touches `.github/`, auth, secrets, `electron-main/src/db.ts`, or release config stays held, including a rename out of those paths. The write App does not post PROOF comments.

`ci` (including `notes-windows`) and `screenshot-check` already run on `merge_group`.

## Proof (Phase 1a, accepted by Ivy, PM)

Phase 1a proof is required CI green from `main`'s workflow revision on the exact tip. Ivy accepted that trust level.

For each of `.github/workflows/ci.yml` and `.github/workflows/screenshot-check.yml`, the latest Actions run on that tip must have `event` `pull_request`, `status` `completed`, and `conclusion` `success`. `run.head_sha` is the tip. The run's pull request link head SHA, base ref, and base SHA match the pull request now. The workflow file blob at that tip equals the blob on `main`. A later failure, cancellation, or in-progress run on that SHA voids an earlier success. An author `PROOF @ <sha>` comment is an assertion and does not count. The write App does not post one.

`MYTHOS_FLOW_AUTHOR_ALLOWLIST` is an author allow-list. It is not a team-membership check. The value is a comma-separated list of GitHub logins, compared case-insensitively. A missing or empty variable holds every pull request. The head repository must be `Sky-High-Infinite-Techwork/Mythos-Writer`; a fork is held. An author whose login is not in the list is held. The suggested initial value is `SkyyPlayz,cursor[bot]`.

GraphQL `author.login` for a bot omits the `[bot]` suffix that REST includes (`cursor` versus `cursor[bot]`). The flow reads `author.__typename`. When that is `Bot` and the login does not already end in `[bot]`, the comparison uses `login[bot]`. A User named `cursor` does not match the allow-list entry `cursor[bot]`.

The publisher does not read `MYTHOS_FLOW_AUTHOR_ALLOWLIST`, and it cannot undraft or enqueue. It mirrors an existing trusted head gate onto a queue commit. It can also post head success when the reducer result is accepted. In Phase 1a the reducer cannot pass, so that head post does not run.

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
| `mythos-claude` | `CLAUDE_CODE_OAUTH_TOKEN` | Not read. Phase 1a does not call Claude. |
| `mythos-codex` | `OPENAI_API_KEY` | Not read. Phase 1a does not call Codex. |

`MYTHOS_CONTROL_READ_TOKEN` is a fine-grained PAT for Mythos-Writer with Actions variables read and metadata read. It cannot write contents or pull requests. The two App private keys stay in different environments and different jobs.

Do not add `OPENROUTER_API_KEY`.

## Before the switch may be set true

Confirm each of these in the GitHub API or settings UI. The workflows cannot see environment branch policy or repository-secret copies.

1. `UNATTENDED_ENABLED` is still `false`. `MYTHOS_FLOW_AUTHOR_ALLOWLIST` is set to the logins that may be undrafted or enqueued. Start with `SkyyPlayz,cursor[bot]`.
2. Environments `mythos-writer`, `mythos-publisher`, `mythos-control`, `mythos-claude`, and `mythos-codex` exist, and each deployment branch policy allows only `main`.
3. `MYTHOS_WRITE_APP_PRIVATE_KEY` exists only in `mythos-writer`. `MYTHOS_GATE_APP_PRIVATE_KEY` exists only in `mythos-publisher`. Neither exists as a repository Actions secret.
4. `MYTHOS_CONTROL_READ_TOKEN` exists in `mythos-control`, `mythos-writer`, and `mythos-publisher`. It is a Writer-only fine-grained PAT with Actions variables read and metadata read, and it has no contents or pull-request write.
5. The write App installation is `182422539` on Mythos-Writer only. Its repository permissions are the ones created with the App: Contents, Pull requests, and Issues read/write; Checks, Actions, and Metadata read. It does not have Workflows permission.
6. The gate App is `5736520`. Its installation id variable matches the installation on Mythos-Writer.
7. A `workflow_dispatch` dry-run of both privileged workflows was watched while the variable was still `false`, and the runs exited without writes.
8. Enqueue needs Merge queues write on the Mythos Writer Flow App and a code change that requests that permission on the token. This workflow requests Pull requests write only. Until both exist, GitHub rejects enqueue and the job fails closed.

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
