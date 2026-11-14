# Mythos Writer — agent rules

## Claude sessions (standing rule, Skyy 2026-11-14)
Every Claude session starts from this line: *Use subagent fan-out liberally. Always use the right agent/model at the right effort for each job. You may use Fable 5.2 and Ultracode when necessary.* Opus 5.5 leads plans, builds, reviews, fixes and small jobs and hands cheap parts to Haiku or Sonnet subagents. Only the tiniest jobs (rebase, lint or format fix, one-line change, label or assign ops) run straight on Sonnet or Haiku. Claim an issue only while you are building it (see `CONTRIBUTING.md`, "Claiming work").

## Source of truth
- The task's dispatch (plan slice + design delta) sets scope. Don't add surfaces it doesn't name.
- Owner decisions: `plans/ProjectGoalOverView/00-decisions-log.md`. Design: `plans/design-handoff/v2/`; the prototype wins any disagreement with `FULL-SPEC.md`.

## Done = required checks green on the PR head
Required: `ci`, `notes-windows`, `screenshot-check`. A branch with any red required check is not done.
- `ci` aggregates lint, typecheck, unit, `build-electron` and four Playwright e2e shards (path-filtered; docs-only diffs may skip e2e).
- `notes-windows` runs native Windows notes/vault suites that Linux CI can't see.
- `screenshot-check`: PRs that touch renderer UI need a screenshot in the PR body or a comment, or the `screenshot-exempt` label.
- `build-linux` / `build-windows` run on `main` pushes, `workflow_dispatch`, and `release.yml` (not on pull requests). There is no `build-macos` job.
- A red required check that is unrelated to your diff still blocks. Report it; don't work around it.

## Never merge
Builders never merge or enable auto-merge. `.github/workflows/mythos-gate-auto-merge.yml` was removed. A human merges only after tip-bound Critic + Shield + Probe and the required checks (`docs/MERGE_GATE.md`).

## Validate locally (repo root, npm workspaces: frontend, electron-main, shared)
```bash
npm ci
npm run lint -w frontend
npm run typecheck
npm run test
rm -rf out/ && npm run build:electron   # e2e launches out/main/main.js, so rebuild first
xvfb-run --auto-servernum npx playwright test e2e/<spec>.spec.ts --reporter=list --workers=1   # drop xvfb-run if a display exists
npm run preflight                       # full CI-parity gate; `-- --fast` skips e2e (CI-PREFLIGHT.md)
```

## Tests
- If a change alters behavior, add or update tests in the same PR. Each new test must fail before the fix.
- Never weaken a test to get green: no deleted assertions, `.skip`/`.only`, widened timeouts or looser locators.
- Reachability: a user must reach the feature from a fresh profile by clicking. Tests must not pre-seed the thing under test.
- Wire a new e2e spec into an existing `test:e2e:*` script in `package.json` that `ci.yml` already runs. Don't edit `.github/`.

## No-touch without owner approval (carve-outs)
`.github/**`, migrations (`electron-main/src/db.ts`, vault migrations), auth, secrets / `.env*`, release config (`release.yml`, `electron-builder.*`). Make dependency or lockfile changes, and version bumps, only when the task asks for them.

## Cross-platform
- Match import casing exactly (Linux CI is case-sensitive).
- Build filesystem paths with `path` helpers; never hardcode separators.

## Code hygiene

- ARIA: prefer native elements; any role you add follows its full WAI-ARIA pattern; never aria-label a plain span/div; never leave a focusable control inside an aria-hidden subtree; run axe on changed components.
- After deleting, renaming or moving a file, symbol, view or path, rg the repo for the old name and fix every comment, doc and spec that still names it in the same PR.

## Final report
What changed; tests added or relied on; why `ci` and `notes-windows` should pass (or why N/A); remaining risks.
