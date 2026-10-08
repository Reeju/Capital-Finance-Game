# Release checklist

## Acceptance criteria (specification §19)

| Criterion | Status | Evidence |
|---|---|---|
| First informed investment within two minutes | Met in automation | e2e test 1 (about 1 s scripted; not timed with a real new player) |
| All actions use real rules, no mocked balances | Met | UI only submits commands; previews call the engine's own quote functions |
| Solo AI and 2–4 seat local Quick/Standard complete and survive save/resume | Met | AI-match tests (12 and 20 rounds, 3–4 seats); e2e 2 (reload/resume), 3 (local) |
| Stocks, private businesses, property, debt, dividends, reinvestment consistent in journal and net worth | Met | rules tests + per-step `auditState` |
| Six regimes and typed events, explainable, no guaranteed forecast | Met | macro tests; "Why it moved" and asset breakdowns in UI |
| Free trades, binding loan/dividend contracts, non-binding bluffing, auction, >50% control | Met | rules tests; online full-match test |
| Distress never eliminates; repeated default bounded | Met | distress tests |
| Winner and replay agree with audited valuation | Met | endgame tests; replay hash tests; server replay audit |
| Online: working authoritative server with evidence; availability stated accurately | **Partly.** Server and tests exist and pass locally. Not hosted; not run on two physical devices. Labelled beta; the client reports "unavailable" when no server answers. |
| PWA offline local play, responsive layouts, accessibility basics, measured budgets | **Partly.** Offline, layouts, target sizes, 200% text and engine/bundle/message budgets verified in automation. Screen readers, real phones, memory and frame rate not measured. |
| Build/typecheck/lint/unit/integration/E2E/content validation pass; deployment, licence and privacy docs | Met | test-report.md; hosting.md; dependencies.md; privacy.md |

## Before a friends build
- [ ] Play one full Quick game solo and one pass-and-play game on an actual iPhone and an actual Android phone.
- [ ] Install to the home screen on both; confirm offline launch.
- [ ] Walk the main flow with VoiceOver and TalkBack.
- [ ] Two people, two devices, one online room over the same Wi-Fi: full 12-round game with a trade, an auction and a tender.
- [ ] Time real matches; adjust the Quick/Standard estimates in Setup.

## Before any public online release
- [ ] Deploy single-origin behind TLS (hosting.md); repeat the two-device game against the hosted server.
- [ ] Decide the three open balance flags (balance.md) with playtest evidence; rerun `pnpm simulate`.
- [ ] Run a dependency advisory audit and a secret scan on the repository.
- [ ] Decide retention and write the public privacy notice from privacy.md.
- [ ] Remove the "beta" label only after the above.

## Every release
- [ ] `pnpm check` and `pnpm test:e2e` green.
- [ ] If rules or content changed: bump `RULES_VERSION` / content `version`, run `tsx tools/makeGolden.ts`, review the diff.
- [ ] Confirm old saves either load or show the "made with rules X" message; never a silent reset.
