# Final implementation review — 8 October 2026

**Reused:** React, Vite, vite-plugin-pwa/Workbox, Dexie, Zod, Recharts, Radix Dialog, ws, Node's SQLite, Vitest, fast-check,
Playwright, ESLint. Versions and licences in dependencies.md.

**Custom, on purpose:** the rules engine and economy, content, RNG and hashing, seat projection, AI heuristics, the server's
command path and clocks, save export/import with replay verification.

**Complexity removed or avoided during the build:**
- Validation and execution share one code path (`execute` with a dry-run flag) instead of parallel validators.
- Reservations and pledges are derived from offers/loans/contracts rather than stored on players.
- No state library: one `View` object per session through `useSyncExternalStore`.
- No game-rendering engine, no ORM, no event-sourcing framework, no provider registry.
- Dropped during review: an unused AI import and scoring variable, a redundant re-export, a convoluted encumbered-sale
  branch, a stripped-events projection that hid nothing secret, a three-way pane layout hack replaced by CSS.

**Checked in the code:** no `any`; non-null assertions only in tests; no `eval` or remote content; engine free of `Date`
and `Math.random` (lint-enforced); timers, sockets, listeners and Web Locks are released on dispose; unused dependencies:
none found; secrets: none in the repository (seat tokens are generated at runtime and stored hashed).

**Not reviewed by anyone else.** This note is the author's own pass, not an independent review.

**Evidence and limits:** test-report.md and known-issues.md.
