# Zero-intervention silence fixes

Creed: **cut waste, don't weaken quality.**

PR hygiene (draft-CI comment only; undraft is `mythos-flow-step`): [`.github/workflows/mythos-pr-hygiene.yml`](../../.github/workflows/mythos-pr-hygiene.yml).

## Map (trigger → action → silence failure prevented)

### 1. Draft ready after 2 consecutive CI greens (retired)

| | |
| --- | --- |
| **Trigger** | Was `mythos-pr-hygiene` `draft-ready-on-green`. That job is removed. |
| **Action** | None from hygiene. `mythos-flow-step` undrafts when its policy passes. Hygiene never calls `gh pr ready`. |
| **Silence failure prevented** | A second, weaker undraft path cannot mark a carve-out or an unlisted author ready. |
| **Committed** | `.github/workflows/mythos-pr-hygiene.yml` |

### 2. Self-healing audit-down

| | |
| --- | --- |
| **Trigger** | FAILED stub **and** `vars.MYTHOS_TOKEN_AUDIT_LAST_STATUS` was already `failed` (two consecutive Wed stubs). |
| **Action** | Comment on tracking issue + open/comment `audit-down` issue with `@SkyyPlayz`; fail Actions job (red X). |
| **Silence failure prevented** | Blind Wed gap / stub ignored. |
| **Committed** | Removed with the weekly audit workflow. |

### 3. Gate-avg tip-fix window throttle

| | |
| --- | --- |
| **Trigger** | CURRENT and PRIOR `gate_avg_proxy` both **> 1.5** (prior from artifact / `MYTHOS_GATE_AVG_PREV`). |
| **Action** | Best-effort set `vars.MYTHOS_TIP_FIX_WINDOW_MINUTES=10` (heal to `20` when ≤1.5). Document write if no vars:write token. |
| **Silence failure prevented** | Gate avg drifts >1.5 with nobody reading the digest. |
| **Committed** | `docs/FORGE_TIP_FREEZE.md` |

### 4. Draft-push wake circuit breaker

| | |
| --- | --- |
| **Trigger** | `draft_e2e_tip_storms ≥ 3` in lookback. |
| **Action** | Set `vars.MYTHOS_WAKE_CIRCUIT_BREAKER` to ISO timestamp **now+48h**. Grok Bot PR-watch / Forge MUST stay SILENT on draft `pr-pushed` / CI-fail fan-out until that time. |
| **Silence failure prevented** | Forge re-wake spam while humans ignore. |
| **Committed** | documented in hygiene workflow header |

## Repo vars

| Variable | Meaning |
| --- | --- |
| `MYTHOS_TIP_FIX_WINDOW_MINUTES` | Emergency single-fix window (default **20**; throttle → **10**) |
| `MYTHOS_WAKE_CIRCUIT_BREAKER` | ISO-until silence for draft wakes |
| `MYTHOS_GATE_AVG_PREV` | Prior `gate_avg_proxy` |
| `MYTHOS_TOKEN_AUDIT_LAST_STATUS` | `ok` / `failed` |
| `MYTHOS_TOKEN_AUDIT_ISSUE` | Tracking issue number |
| `MYTHOS_USAGE_SNAPSHOT` | Dual-pool JSON (never invented) |

| Autofix shadow / coord / rollback | [MYTHOS_AUTOFIX.md](../MYTHOS_AUTOFIX.md) |
| Standing brief compression | [STANDING_AGENT_CONTEXT_COMPRESSION.md](../STANDING_AGENT_CONTEXT_COMPRESSION.md) |

### 5. Main-push hygiene has no PRs

| | |
| --- | --- |
| **Trigger** | CI `workflow_run` on a **main push** (no associated pull request). `GET /actions/runs/{id}/pull_requests` returns HTTP 404 and `gh api` still writes the error JSON to stdout. |
| **Action** | `draft-ci-comment` soft-skips (exit 0). Non-numeric tokens never reach `gh pr view`. |
| **Silence failure prevented** | A green main CI run painting hygiene red, which looks like a product outage and invites noise. |
| **Committed** | `.github/workflows/mythos-pr-hygiene.yml`, `scripts/mythos-ops/ops-guards.sh` |

## Explicit non-goals

- Do **not** collapse Critic/Shield/Probe.
- Do **not** skip the plan / tip-SHA gate.
- Do **not** auto-close drafts.
- Do **not** shorten lookback below 7d.
- Do **not** ban Other Models.
