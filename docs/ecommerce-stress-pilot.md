# Real ecommerce stress pilot — 2026-10-04

Result: **INCOMPLETE**, not commercial acceptance. The three-action budget ended normally (`budget-exhausted`). No TODO sequence, scripted decisions, scripted review verdicts, or fault injection were supplied. The DSH implementation was unchanged during the experiment.

## Scope and isolation

A snapshot of the current ecommerce working tree (including uncommitted source changes) created an independent repository: 294 files, 1,339,986 bytes. Secrets, original Git history, virtual environments and dependency directories were excluded. Host checks used existing installed Python/Node dependencies; Workers had no shell/network/commit/push permission. Existing tests, scripts, dependency manifests and project instructions were protected. Model access still requires the configured provider connections.

The goal was evidence-based commercial readiness, with criteria covering backend regression tests, production webpack build, strict TypeScript, anonymous discovery through Dummy-payment order creation, mobile/browser evidence, session isolation, and independently reviewed committed changes. Every action was bounded and followed by fresh observation/decision. Maximum actions: 3; Worker timeout: 180 seconds. Default Codex decision preference and 120,000-character source observation budget were retained.

## Actual execution

| Round | Decision | Builder | Independent reviewer | Outcome |
| --- | --- | --- | --- | --- |
| 1 | Codex | Codex | None: Builder failed before review | Provider usage limit; no accepted change |
| 2 | DSH | DSH | OpenCode | IAM fix accepted after host and clean committed-tree checks |
| 3 | DSH | DSH | OpenCode | Analysis only, empty diff; same commit marked MERGE_READY again |

The run lasted 754,410 ms (12 minutes 34 seconds). Pi was registered but not selected; this pilot does not establish four-provider coverage. Earlier fixture validation remains separate.

Baseline backend result: 123 passed, 1 failed. The failing login test already supplied a fake CommerceAdapter; the IAM factory bypassed FastAPI dependency injection and called the real adapter. DSH changed the factory to resolve the adapter through `Depends`, and mapped login upstream failures to HTTP 502 while preserving authentication HTTP 401 and existing HTTPException responses.

Accepted isolated commit: `46e6bad60a445d2fc4cc5a2acd25e3861722b7cb` (local experiment repository, not a commit in this public repository). Two source files changed, 26 insertions and 4 deletions. Host and clean committed-tree checks passed: **124 backend tests**, production webpack build, and strict TypeScript. OpenCode independently returned PASS. Protected hashes remained intact.

An additional host-owned synthetic probe exercised invalid credentials → 401, unavailable upstream → 502, raised HTTPException → 401, and invalid request → 422. All four passed. This probe substituted the rate limiter and CommerceAdapter; it is not rate-limit, live Saleor or browser acceptance.

All 294 original source hashes matched after the run. Original source and the independent repository's main HEAD were preserved. No ecommerce source, patch, credentials, or raw provider logs were uploaded.

## Findings requiring governance changes

1. **Priority direction is unspecified.** `ASSESSMENT_SHAPE` says only “number”; selection sorts larger values first. Codex used 100 as urgent, while DSH used 1 as urgent. Consequently round 2 selected the review/commit gap numbered 5 instead of the DI defect numbered 1. The Builder then repaired DI despite receiving a governance-oriented action. A consistent priority contract and boundary validation are needed.
2. **Governance work can become a Builder action.** The model proposed “route changes through independent review / create a commit,” although these are Controller responsibilities. Execution success partly depended on the Builder interpreting beyond that selected action. The candidate boundary needs to distinguish product changes, evidence gathering and host governance.
3. **Empty changes count as accepted progress.** Round 3 made no source change and reused the prior commit but received MERGE_READY and a success score. Evidence-only work needs a distinct outcome; budget/progress metrics must not count a duplicate commit as a new fix.
4. **Source observation misses large parts of the project.** The default budget included 42 files and ended at backend infrastructure, before IAM and frontend source. DSH could read additional files through its native read tools; shell-disabled Codex had only the supplied source excerpt. Assessments need an explicit coverage signal and role-appropriate read access.
5. **Authentication changes were classified normal risk.** This selected one independent reviewer rather than the existing high-risk dual-review path. This pilot does not demonstrate automatic path-based authentication/schema risk escalation.
6. **Persisted state growth needs measurement.** The formatted world-state file reached 1,069,809 bytes after three actions. No long-duration growth, actual token accounting or commercial benchmark claim is supported by this run.

## Remaining product acceptance

Docker Desktop launch attempts and the official CLI reported startup, but the Linux engine pipe remained absent and the backend exited. No disposable Saleor stack was available. Therefore live buying flow, mobile/browser usability and runtime session isolation remained **NOT_VERIFIED**. Older project evidence was not accepted as current proof. The Loop did not claim the project complete.

Next acceptance must first establish a reproducible disposable commerce environment, then repeat the product/browser criteria. Before extending run duration, address the measured priority, action-boundary and no-progress issues. This pilot proves a real repair, provider fallback and enforced independent review; it does not prove reliable unattended commercial delivery.

Private local artifacts: snapshot/hash manifest, immutable host policy, durable world state, raw tests/reviews/provider output, accepted patch and host audit. They remain outside the public evidence set.
