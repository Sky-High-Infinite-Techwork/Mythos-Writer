# Phase 2 — unattended dispatcher plan

Phase 2 adds a **dispatcher** workflow that reads Writer **build-order** tracking issues, gates plans, splits work into **slices** (one slice → one PR), claims **lanes** with provably atomic GitHub primitives, and (in later PRs) runs build jobs with strict credential separation. Phase 1 (`mythos-flow-step`, `mythos-final-gate`) stays the undraft/enqueue/gate path on merged PRs.

This document is the design contract for implementation and grading. The prototype for product behaviour remains `plans/design-handoff/v2/`; this doc covers only GitHub Actions automation.

## Scope split (PRs)

| PR | Title | Delivers |
| --- | --- | --- |
| 1 | `unattended: Phase 2 dispatcher core (atomic claims, cap, dry run)` | Plan doc, claim/lane/cap/sweep modules, build-order discovery, dry-run dispatcher workflow, unit tests including 20-way claim simulation |
| 2 | Plan gate + build lanes | `mythos-plan-gate.yml`, `mythos-build-lane.yml`, grade binding in `dispatch-run.js` (act, PR **#1888**) and `dispatch-cli.js` → `plan-gate.js`, `build-lane.js` path guard + fix-round helpers, transport stubs to arm in canary |

PR 1 must not mint provider tokens or run model steps. PR 2 must not relax PR 1 claim invariants.

## Master switches

Both must be the literal string `true` before any write (ref create/delete, issue comment, workflow dispatch, PR create):

| Variable | Default | Role |
| --- | --- | --- |
| `UNATTENDED_ENABLED` | `false` | Phase 1 master switch (existing) |
| `MYTHOS_DISPATCH_ENABLED` | `false` | Phase 2 dispatcher arm |
| `MYTHOS_DISPATCH_LANE_CAP` | `5` | Max concurrent dispatch claims (`1`–`20`; slots `lane-00` … `lane-19`) |

Re-read switches with `MYTHOS_CONTROL_READ_TOKEN` immediately before each mutating step (same pattern as Phase 1 `readSwitch`).

Manual `workflow_dispatch` defaults to **dry-run** (works with switches **off**). Scheduled runs run **sweep only** when both switches are true. **Claim** is manual `workflow_dispatch` + `act` only (never on schedule).

## Build-order work queue

**Source of truth:** open issues listed in repository variable `MYTHOS_BUILD_ORDER_ISSUES` (comma-separated issue numbers, highest priority first). Optional label `mythos:build-order` on issues is advisory; the variable is authoritative for v1.

**Eligibility (read-only scan):**

- Issue open, in-repo (not a fork discussion).
- Issue body and comments are treated as **untrusted** (prompt-injection surface); only structured fields and trusted-author plan comments drive automation.
- An issue is **ready for planning** when it has no in-flight dispatch claim ref whose lease has not expired (see claims).
- An issue is **ready for slice dispatch** only after a **plan grade PASS** is recorded (PR 2); PR 1 stops after logging the would-be claim. Ineligible head-of-line issues (closed, linked PR, no plan, slice done, max attempts) are skipped to the next build-order entry.

## Official plan convention

An **official plan** is the latest issue comment whose:

1. Author login is `SkyyPlayz` or `SkyHigh-Mythos-Bot` (GraphQL bot canonicalization per Phase 1 `canonicalLogin`).
2. Body contains an exact Markdown heading line `## Files` (not `### Files`).
3. Under that heading, one path or glob per line (literal paths or `*` globs, no prose bullets required).

The plan revision key is `(comment_id, sha256(comment_body))`. No build slice may start without a PASS grade bound to that exact pair (PR 2).

## Slices

Given an approved plan:

1. Parse the `## Files` list into normalized path/glob entries (reuse `protectedPath` from `constants.js` for carve-out detection).
2. Split into **slices** either by explicit `## Slice N` sections in the plan (PR 2) or default **one slice = full file list** until multi-slice plans exist.
3. **Disjointness:** two slices may run in parallel only if their expanded file sets do not intersect. Overlap forces serialization (lower slot index first).
4. Each slice carries a **pinned file claim** for the trusted write job: only those paths (plus lockfile paths if the task explicitly allows) may appear in the PR diff.

## Atomic claims and lane cap

### Threat

Labels, local `flock`, and read-then-write counters are **not** used. Double-claim and cap overrun must be impossible under parallel Actions jobs.

### Mechanism

Fixed slot refs:

```
refs/mythos/dispatch/lane-00
...
refs/mythos/dispatch/lane-19
```

**Claim (manual act only):**

1. Read `MYTHOS_DISPATCH_LANE_CAP` (`N`, fail-closed if not an integer 1–20).
2. For the first free slot `i` in `0 .. N-1` with no live lease, call GraphQL **`updateRefs`** with **two** `refUpdates` in one request: `lane-{ii}` and `claim/{issue}-{slice}`, each `beforeOid` = zero OID, `afterOid` = lease commit SHA.
3. Issue a single two-ref `updateRefs` create. On GraphQL **`Reference already exists`**, `GET` the claim ref (and lane ref when recovering) to distinguish another holder from a same-run partial create. Any other error ⇒ fail closed (exit non-zero). After ambiguous errors, **CAS-release only the half we successfully created** in this run (never release a ref we do not hold). Treat as success only for idempotent **same-run** retry (`recoverSameSha`). **Release** of our claim pair always CAS-deletes with `beforeOid` set to the holder’s known `leaseSha` for **each** ref, not a fresh `GET`.
4. Enforce **file disjointness** against live leases (normalized `files[]` in lease JSON).

**Lease commit:** commit on `main`’s tree with message JSON (`schema: mythos-dispatch-lease/v1`):

```json
{
  "issue": 1234,
  "slice": 0,
  "planCommentId": 999,
  "planBodySha256": "<hex>",
  "runId": 5678,
  "files": ["frontend/foo.ts"],
  "runAttempt": 1,
  "claimedAt": "ISO-8601",
  "expiresAt": "ISO-8601"
}
```

Default TTL: **180** minutes (`MYTHOS_DISPATCH_LEASE_MINUTES`, clamped **30–360**). Must exceed longest lane job timeout plus margin.

**Release / sweep / renew:** GraphQL `updateRefs` with `afterOid` = zero OID (delete) or a new lease commit SHA (renew). **`beforeOid` semantics:** **release** — the holder’s known `leaseSha` (never a pre-delete `GET`); **sweep** — the SHA observed when listing refs before delete; **renew** — the holder’s known `leaseSha` with `force: true` because the new lease commit is a sibling of the old on `main`. Re-read `UNATTENDED_ENABLED` and `MYTHOS_DISPATCH_ENABLED` before **every** delete in sweep (lane-`NN` and `claim/*` only — never `attempts/`, `done/`, or `canary/`). **Lease heartbeat renew** (holder extends `expiresAt` via a new lease commit) ships in **PR 2** with live publish; PR 1 implements sweep/release CAS only. Holders use **`assertHolderBeforePublish`** before publishing.

**Identity:** `refs/mythos/dispatch/claim/{issue}-{slice}` (no body SHA in the ref name).

**Attempts / done:** `refs/mythos/dispatch/attempts/{issue}-{slice}` counts dispatch attempts with exponential backoff (`MAX_DISPATCH_ATTEMPTS` = 5). `refs/mythos/dispatch/done/{issue}-{slice}` means the slice finished; dispatcher skips to the next build-order issue. An attempt is recorded only after a successful claim.

**Path policy:** Empty literal glob prefix (e.g. `**/*`) is protected. Overlap checks are bidirectional for `.git*` vs `.github/**`.

### Proof (unit test + live canary)

The **mock** proves CAS-shaped **two-ref** `updateRefs` pair creates (lane + claim) and 20-way single-winner behavior in memory. It does **not** prove GitHub’s live GraphQL atomicity.

**Unit:** Parallel `Promise.all` of 20 attempts on **one** slot → exactly **one** success, **19** `Reference already exists`, **0** fatal errors.

**Live canary (`mythos-dispatch.yml`, `MODE=act`, switches on):** six parallel jobs race on `refs/mythos/dispatch/canary/scratch-{runId}-{runAttempt}` for that workflow run; exactly one `canary_win`, the rest record `Reference already exists` — this proves **single-ref create** atomicity only. The **two-ref claim pair** is proven by the mock, not the live canary. `canary-verify` scores all six leg artifacts for the same run/attempt, then CAS-deletes only that run’s scratch ref when its SHA matches `MAIN_SHA`.

## Global lane cap across jobs

Cap is enforced by **only allocating the first N slot ref names** (`lane-00` .. `lane-{N-1}`) and treating **any live lease on a lane ref at any index** (including slots at or above `N` from a prior higher cap) as counting toward the concurrent-lease limit. Jobs do not count refs in a racy read-then-write loop for slot picking beyond that rule. Listing refs is for observability and sweeper only.

Per-PR **review** jobs (PR 2) use a matrix or `parallel` without a global `concurrency: 1` on review — only **mutate** steps share `mythos-unattended-mutate` with Phase 1.

## Job and credential split (PR 2 preview)

| Job class | Environment | Secrets | May write git/PR |
| --- | --- | --- | --- |
| Admit / discover / plan / grade / build (model) | none or read-only | Provider keys only in `mythos-claude` / `mythos-codex` | No |
| Trusted publish | `mythos-writer` | Write App key | Yes, after path-content guard |
| Gate publish | `mythos-publisher` | Gate App key | Checks only |

Rules:

- Provider jobs export `GITHUB_TOKEN: ''` and `GH_TOKEN: ''` where Phase 1 does.
- Write App token is minted only in publish/push jobs; model containers never receive `MYTHOS_WRITE_APP_PRIVATE_KEY` or minted write tokens.
- Path guard: diff of proposed commit ⊆ slice claim; any protected path (`PROTECTED_PATH` in `constants.js`) aborts and applies `carve-out` / owner hold label via write App.

## Plan gate (PR 2)

1. Claude (native Anthropic model IDs via `mythos-claude` — e.g. `claude-opus-4-20250514` / `claude-sonnet-4-20250514`; no OpenRouter) drafts plan comment body with `## Files`.
2. A **different** Claude model grades independently (e.g. `claude-3-5-haiku-20241022`); output schema `mythos-plan-grade/v1` with `PASS` | `REVISE` and findings.
3. Revise loop until `PASS` or max rounds (`MYTHOS_PLAN_GRADE_MAX_ROUNDS`, default 3).
4. Store PASS as issue comment with `PLAN GRADE PASS @ comment=<id> sha=<hex>` from gate bot or trusted template; dispatcher reads it before slice claim.

No build job starts without PASS bound to `(planCommentId, planBodySha256)`. **`mythos-dispatch.yml` `act` and `dry-run` both hold** (continue/skip) when `findBoundPlanPass` fails — there is no claim without a bound grade pass.

## Build lanes (PR 2)

- Lead: **Claude Code** official action pinned by full commit SHA; use native Anthropic model IDs in env (not OpenRouter slugs).
- Alternate: **Codex** in `mythos-codex`.
- **The model job never pushes.** After the provider step, a trusted **`push-build`** job (write App, `mythos-writer`) commits any model worktree changes and updates `refs/mythos/build/<provider>`, outputting `build_head`. **`publish`** checks out the guard scripts at the claim base `MAIN_SHA`, fetches that build ref, and runs `git diff --name-status -M <base>...<build_head>` (fail closed). While build transport is still a stub, push/publish **hold** (exit 1); they never pass.
- Provider and write credentials stay in **separate jobs**; build job uploads transport stdout only; trusted jobs apply and verify.
- **Fix rounds:** rerun only failed required check subsets; before merge queue, full required set on tip (align with `MERGE_GATE.md`).

## Fix rounds

Track per-PR failing check names from the last tip. Fix jobs request a minimal rerun list. After fix push, dispatcher sets `full_verify_required` until `ci`, `notes-windows`, and `screenshot-check` are green on the new tip.

## Dry-run mode

When `MODE=dry-run`:

- Run admit, discover, official-plan parse, slice disjointness, lane **would-claim** logic.
- Log structured JSON lines: `would_claim`, `slot`, `issue`, `slice`, `files`, `reason`.
- No `POST`/`DELETE` on refs, no `workflow_dispatch`, no App token mint.

## Threat list and mitigations

| Threat | Mitigation | Test |
| --- | --- | --- |
| Prompt injection from issue text | Trusted authors only for plans; model system prompts treat issue body as data; no `workflow_dispatch` from issue events | Unit: untrusted author comment ignored; workflow has no `issue_comment` trigger |
| Write token exposure to model | Separate jobs/environments; spawn env strip in `spawn.js` | Workflow scan: no provider job contains write App key; `unattended.test.js` pattern |
| Runaway loops / cost | Max plan grade rounds; lease TTL; sweep stale claims; switches off by default | Unit: lease expiry triggers sweep delete; grade round cap in PR 2 |
| Double claims | Atomic ref create per slot + per-slice claim ref | Live canary (6-way scratch ref); mock exercises CAS shape only |
| Stuck leases | Sweeper deletes expired slot refs; fail-closed if switch off mid-run | Unit: stale `expiresAt` → sweep |
| Protected path escape | `protectedPath` + diff guard in trusted job | Reuse `filesLookProtected` tests; path guard unit tests in PR 2 |
| Cap overrun | Only first N slot names attempted | Mock: 6 workers, cap 5 → one lane-full |
| OpenRouter / extra keys | Forbidden in workflows | `workflow-rules` / unattended contract: no `OPENROUTER` |

## Workflow layout (PR 1)

`mythos-dispatch.yml`:

- Triggers: `schedule` (sweep only when armed), `workflow_dispatch` (dry-run default; optional canary matrix).
- Jobs: `admit` → `discover` (`mythos-control`, dry-run plan) → `sweep` (CAS delete lane/claim only) → `claim` (manual `workflow_dispatch` + `act` only) → optional `canary` + `canary-verify` (6 parallel creators on per-run `canary/scratch-{runId}-{runAttempt}`, one winner, CAS cleanup on pass only).

Concurrency: `mythos-unattended-dispatch` for sweep+claim orchestration job; do not serialize future per-PR reviews.

## Variables and secrets (names only)

**New variables:** `MYTHOS_DISPATCH_ENABLED`, `MYTHOS_DISPATCH_LANE_CAP`, `MYTHOS_BUILD_ORDER_ISSUES`, optional `MYTHOS_DISPATCH_LEASE_MINUTES`, PR 2: `MYTHOS_PLAN_GRADE_MAX_ROUNDS`.

**Existing:** `UNATTENDED_ENABLED`, `MYTHOS_CONTROL_READ_TOKEN`, `MYTHOS_WRITE_APP_*`, provider environments.

**Forbidden:** `OPENROUTER_API_KEY`, OpenRouter in any workflow.

## Live canary (not CI)

- Set build-order issue with official plan comment; dry-run dispatch logs correct slice.
- **PR 1:** manual `act` plan runs hold at `plan_not_graded` (no `findBoundPlanPass` yet); use mock/unit tests for claim CAS. **PR 2+:** two manual act dispatches with cap 1 — second is lane-full.
- Force expired lease; sweep removes ref; slot reusable.
- PR 2: plan grade revise loop; single-file slice PR; protected path triggers hold.

## Grading checklist (for independent review)

1. Plan gate before build with bound revision — specified for PR 2; PR 1 does not start builds.
2. Slices disjoint for parallel — specified and tested in unit tests.
3. Atomic claims — slot refs + claim refs; live canary + mock CAS tests.
4. Global lane cap 1–20 — slot index bound.
5. Credential split — documented; PR 1 has no provider/write in same job.
6. Fix rounds — documented for PR 2.
7. Dual switch + dry-run — implemented PR 1.
8. No OpenRouter — contract tests.