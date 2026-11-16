# Mythos merge gate

Conditions for landing on `main`. The merge queue performs the merge.
Builders do not merge, and they do not wait on Critic, Shield, Probe, or Ivy.

`.github/workflows/mythos-gate-auto-merge.yml` (check name
`mythos-gate-auto-merge`) was removed. Do not restore it.

Fail-closed: if any condition below is missing or ambiguous, the flow does not
enqueue.

## Who lands a pull request

| Path | What happens |
| --- | --- |
| Ordinary product and docs pull requests | `mythos-flow-step` enqueues into the `main` merge queue when the checks below are green on the exact head. The queue re-tests the merged result, so a pull request that is behind `main` can still be enqueued. A merge conflict (`DIRTY`) stays held. |
| Dependabot | Held. Patch and minor auto-merge is a follow-up. |
| `.github/**` | Owner-merged. The flow holds these, including a rename out of `.github/`. |
| Other high-risk paths | Eligible only after a strict provider review for the exact head. The gate check must be success from gate App `5736520`, with `Risk: low` and `Review: strict`. Any block, or any risk other than low, stays held. |
| Releases | [`release.yml`](../.github/workflows/release.yml) stays draft until the owner publishes. |

Copilot and other builder agents never merge (see `.github/copilot-instructions.md`).
No build step and no merge step waits on Grok.

`hold`, `do-not-merge`, and `tip-freeze` still keep a pull request out of the
queue. The `carve-out` label alone does not. On a high-risk pull request it is
the old marker; a strict low-risk pass is what makes that pull request eligible.
On any other pull request the label still holds.

## The gate check

`mythos/final-gate` is posted by gate App `5736520`. A success is for one head
SHA. It comes from provider review (Claude, and Codex only when that transport
is configured and also passes). The review has to pass at low risk. High-risk
paths use a stricter prompt: uncertainty, a block, or any risk other than low
is not a pass.

The check summary starts with `Head: <sha>` and includes `Risk: low`. A strict
pass also includes `Review: strict`.

Required CI checks, also on the merge queue: `ci`, `notes-windows`,
`screenshot-check`. `carve-out-check` completes and labels. It does not fail
the build.

Evidence for the flow is a successful pull-request run of those CI workflows
on the exact head, using `main`'s copies of the workflow files. A newer `main`
does not void that evidence.

## High-risk paths

The flow uses the same path list as `batch-automerge` (dependency manifests,
lockfiles, `*.config.*`, `.claude/`, `AGENTS.md`, auth, secrets,
`electron-main/src/db.ts`, release and electron-builder config, and the rest
of that list). `.github/**` is the owner hold. Every other path on the list is
high-risk and needs the strict pass above.

## Merge method

The `main` merge queue squashes. The flow enqueues with `expectedHeadOid` set
to the full head SHA. It does not push, rebase, or jump the queue.

## Out of scope

- Rulesets and repository settings. The owner turns the queue and
  `UNATTENDED_ENABLED` on.
- The batch lane. Retargeting `batch/**` is an owner settings change, not this
  gate.
- `release.yml` publish policy.
