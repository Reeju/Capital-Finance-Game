# Test report — 8 October 2026

Machine: macOS (Darwin 25.6), Node 24.11.0, pnpm 12.10.1. All commands run from the repository root.
Everything below was run after the final code change of this build session.

| Command | Result |
|---|---|
| `pnpm typecheck` | Pass (strict; engine, content, AI, protocol, server, tools, tests, web) |
| `pnpm lint` | Pass, 0 errors, 0 warnings |
| `pnpm content:validate` | Pass: content-1.0.2, 10 companies, 4 properties, 12 events |
| `pnpm test` | **51 / 51** in 2 files, ~2 s |
| `pnpm test:multiplayer` | **14 / 14**, ~6 s |
| `pnpm test:e2e` | **8 / 8**, ~60 s, Chromium headless at 390×844 against the production build |
| `pnpm build` | Pass. Initial JS 203 KB gzip; lazy chart chunk 106 KB gzip; CSS 2.9 KB gzip |
| `pnpm simulate 1000 12` / `1000 20` | Completed in 29 s / 56 s; 0 rejected AI commands; audits passed. See balance.md for flags |
| `pnpm bench` | Command p95 0.18 ms (budget 10); Close 0.73 ms (budget 50); AI p95 0.25 ms per decision (budget 100) |

## What the suites cover

**Engine rules (`packages/engine/src/__tests__/rules.test.ts`, 45 tests):** rounding and residual cents; the $10 B limit;
AP, adjacency and location; rotating start seat; rejections leaving state, revision and RNG untouched; stale envelopes;
system-only timeouts; property seed values ($325,000 / $233,333.33 / $268,750 / $320,000); EV/EBIT and single deduction of
corporate debt; the 4.2-turn tech multiple move for +3% rates; the net-worth example; quotes not mutating; spread and impact;
round-trip loss; float and holding limits; control at 4,999 / 5,000 / 5,001; payout and once-per-year policy; pro-rata
dividends; reinvestment from company cash; post-funding loan approval; amortisation, fixed vs floating, maturity; double
pledge; refinancing fee and collateral; arrears and the rescue window; single 50% write-down; reputation and credit freeze;
exactly one restart grant; second collapse without elimination; collateral-first liquidation; rescue trades; reservations
and proposal caps; atomic acceptance and the inventory race; expiry; player loans on both balance sheets; dividend rights
without double counting; auction escrow and release; unsold lots; tender price floor, escrow, failure refund and pro-rata
fill; bank asset pricing; rent only to owners; warehouse synergy; no Crisis in year 1 and no disasters in years 1–2 over
150 seeds; macro and price clamps over 20 long runs; event expiry; the tutorial script; research bounds, no reroll, no
macro-stream draws; observation leakage; final ranking, bonus cap, no extra news draw; shared wins.

**Invariants (`tests/unit/invariants.test.ts`, 6 tests):** 150 fast-check runs of 20–160 random legal and illegal commands
(including wrong actors) with conservation, share totals, non-negative cash and reservations checked after every step;
four full AI matches with per-step audits; replay to an identical state hash; a pinned golden replay; AI on observations;
content schema rejecting unknown metrics, bad bounds and extra fields.

**Online (`tests/multiplayer/online.test.ts`, 14 tests, real HTTP and WebSocket):** cookie flags; no socket without the
cookie, with a forged token, from a foreign origin or with another room's token; cross-site and non-JSON POSTs refused;
full and started rooms; host-only actions; no seed/RNG/pending news/rival research/third-party offers/token hashes in any
message a client receives; wrong actor, stale revision, client-sent `TimeoutTurn`, malformed and oversized payloads;
duplicate command executed once with the stored acknowledgement; database failure before commit leaving state untouched;
two same-revision commands, one accepted; a complete 12-round match with a trade, an auction and a successful tender,
followed by a server-side replay audit; reconnect mid-turn; timeout passes; grace period then AI takeover and hand-back;
server restart with state restored and play continuing; pause vote and suspension when everyone leaves.

**Browser (`tests/e2e/game.spec.ts`, 8 tests):** first investment in the tutorial in well under two minutes; a full Quick
solo game to the results screen with a mid-game reload and resume; pass-and-play curtain; no horizontal scroll and ≥ 44 px
targets at 390×844 and 844×390, and at 200% text; service-worker offline reload, resume and play; two separate browser
contexts creating, joining and playing an online room with a mid-turn reload; export, tampered and junk imports rejected,
good import replayed; second tab read-only.

Also checked by eye in the app's browser pane: Home, Setup, City, Market, the company sheet and the three-column wide layout.

## Not tested
- Any physical phone or tablet; iOS Safari and Android Chrome installation; VoiceOver and TalkBack.
- Online play between two physical devices, on a real network, or on a hosted server (nothing is deployed).
- Browsers other than Chromium headless.
- Memory use, frame rate and battery on a phone. No profiling on a representative device.
- A rescue/restructuring flow driven through the browser UI (covered at engine level only).
- IndexedDB quota failure in a real browser (the code path exists; it was not forced in a test).
- Service-worker update from one deployed build to the next.
- Human playtests: actual match length and whether the game is fun are unknown.
- A dependency security audit beyond pnpm's install-time lockfile policy check.
