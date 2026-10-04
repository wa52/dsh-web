# Real ecommerce browser acceptance — 2026-10-05

Result: **PASS for the bounded core buying-flow experiment**, not complete commercial or unattended-runtime certification. After accepted changes, fresh observation and an independent decision returned `complete` without another Builder action.

## Environment and scope

The current 294-file ecommerce snapshot ran in an independent Git repository and isolated worktrees. Docker Desktop was restored by preserving and replacing broken runtime socket directories. A separate Compose project used copied Saleor/AI databases, read-only original media and private generated test secrets. Original services remained separate. Host-deployed source matched each candidate and clean committed tree; old container images were not treated as evidence for current source.

Host-owned acceptance used real headless Edge through Playwright at 1440px and 390px. No TODO sequence, scripted model verdicts or fault injection was supplied. Codex was quarantined after the observed inherited-MCP policy bypass described in [the pilot report](ecommerce-stress-pilot.md#subsequent-confinement-finding). This workaround does not fix its adapter.

## Actual loop

| Action | Decision | Builder | Review | Outcome |
| --- | --- | --- | --- | --- |
| 1 | Codex | Codex | Not reached | Timed out; unaccepted changes; observed MCP bypass |
| 2 | DSH | DSH | Not reached | Controller stopped for confinement audit; recovery preserved failure |
| 3 | DSH | DSH | OpenCode startup failed; Pi retried and rejected | Cart payload corrected, but currency/description checks still failed |
| 4 | Pi | Pi | DSH PASS | Host and committed-tree checks passed; MERGE_READY |
| Final observation | Pi | None | Prior accepted evidence retained | Goal complete; no extra build action |

OpenCode could not launch the large review request on Windows (`spawn ENAMETOOLONG`). This is a real transport failure, not a negative review verdict. Pi independently retried review. Partial cart repair was rejected by both the remaining host failures and Pi. The next decision chose currency repair; Pi also applied the existing plain-description helper to recommendations.

Accepted local experiment commit: `fcf85544a753a6ce73c9f14a82cde1edcd49e900`. This is **not** a public DSH repository commit. Combined with the earlier IAM repair, the accepted patch changes six source files, 52 insertions and 14 deletions. Source patches and raw logs remain private.

## Evidence

- Existing backend tests: **124 passed**.
- Production webpack build and strict TypeScript: **passed**.
- Formatter checks: USD, CNY and EUR correctly distinguished; no invented conversion.
- Real browser acceptance: **34 passed, 0 failed**, on both Builder and clean committed trees, and again during final observation.
- Buying flow: anonymous discovery, available variant, quantity two, persistence after reload and new browser context, address/shipping, customer registration/login, Dummy payment, order creation, checkout clearing and customer order history.
- Presentation/session checks: readable recommendation descriptions, truthful currency on product/cart/checkout/payment/order screens, no tested horizontal overflow or uncaught browser errors, independent merchant token key preserved through customer login/logout.
- Original source audit: **294 hashes unchanged**. Protected tests, dependency manifests and project instructions unchanged. Isolated repository main HEAD preserved; accepted candidate remains on its own branch.

## Limits

Only a single-variant product fixture, two viewport sizes and Dummy payment were exercised. The merchant token check used a sentinel; it does not verify real merchant authentication. New browser context is not a full browser-process restart. Pixel polish, all devices, multi-variant selection, real payments and long-duration operation remain unproved.

The reviewer retained a non-blocking finding: when both subtotal and line currency are absent, the existing subtotal fallback can assume USD. The tested real Saleor flow supplies currency; unknown-currency behavior still deserves follow-up.

The runtime's earlier priority, no-op progress, source coverage and risk-classification findings remain open. Native Codex confinement is still not repaired. Therefore this experiment establishes a real bounded repair/reject/replan/review/stop cycle, not reliable unattended commercial delivery.

Private artifacts include immutable acceptance scripts, screenshots, world state, review/test logs, source hash audit and the accepted patch. No customer database dumps, ecommerce source, credentials or provider logs are included here.
