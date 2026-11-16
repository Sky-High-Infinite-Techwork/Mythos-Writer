# Unattended flow (Phase 1)

GitHub Actions is the engine. These workflows do nothing until the repository variable `UNATTENDED_ENABLED` is the literal string `true`. Any other value, including a missing variable, exits without a write and without posting `mythos/final-gate`.

The switch is read again, with `MYTHOS_CONTROL_READ_TOKEN`, immediately before each undraft, enqueue, and check post. One API call that was already authorized can still finish. Turning the variable off does not cancel a merge GitHub has already accepted and does not erase a green check.

## Workflows

| Workflow | What it does |
| --- | --- |
| `mythos-final-gate.yml` | Schedule and manual run from `main`. Claude and Codex jobs emit an unavailable result and call no model. The reducer cannot pass on that result. The publisher, in a separate job, mints the gate App token only when a queue commit or a reducer pass needs a check. It posts `mythos/final-gate` on a `main` queue commit only when the pull request head already has that check from App 5736520 and `git merge-tree --write-tree` reproduces the queue tree. |
| `mythos-flow-step.yml` | Schedule and manual run from `main`. Confirms independent `PROOF @ <full tip sha>` from the pull request author or `cursor[bot]`, undrafts a draft that already has that proof and green `ci`, `notes-windows`, and `screenshot-check`, then enqueues a non-draft whose tip also has `mythos/final-gate` success from App 5736520. Enqueue is GraphQL `enqueuePullRequest` with `expectedHeadOid` set to the full tip SHA. |
| `mythos-automation-contracts.yml` | Pull request and merge queue. No environment and no secrets. Runs the controller tests. |

Manual runs default to `dry-run`. `act` is the mode that can write. A scheduled run is `act`, and it still stops when the variable is not `true`.

Phase 1 does not push, rebase, dispatch new work, call OpenRouter, pass `--admin`, or auto-merge `batch/**`. A pull request that touches `.github/`, auth, secrets, `electron-main/src/db.ts`, or release config stays held. The write App does not post `PROOF` comments.

`ci` (including `notes-windows`) and `screenshot-check` already run on `merge_group`.

## Variables

Repository Actions variables:

| Name | Value |
| --- | --- |
| `UNATTENDED_ENABLED` | `false` until a watched canary. `true` arms new runs. |
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
| `mythos-control` | `MYTHOS_OPS_CHECKOUT_TOKEN` | Not read by these workflows. Phase 1 Ops scripts are not on Ops `main`, so this PR does not check out private Ops. |
| `mythos-claude` | `CLAUDE_CODE_OAUTH_TOKEN` | Not read. Model jobs do not call Claude. |
| `mythos-codex` | `OPENAI_API_KEY` | Not read. Model jobs do not call Codex. |

`MYTHOS_CONTROL_READ_TOKEN` is a fine-grained PAT for Mythos-Writer with Actions variables read and metadata read. It cannot write contents or pull requests. The two App private keys stay in different environments and different jobs.

Do not add `OPENROUTER_API_KEY`.

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
