# Capital

A witty financial board game for 2–4 seats: valuation, compounding, leverage, negotiation and surviving your own mistakes.
Fictional companies, fictional dollars, no real securities and no investment advice. Working title.

Built from `Capital — implementation specification v1.1`. React + TypeScript + Vite PWA, one deterministic integer engine
shared by solo, pass-and-play and the authoritative online server.

## Status

| Mode | State |
|---|---|
| Solo vs 1–3 AI (Grace, Alex, Victor), Quick 12 / Standard 20 | Works, saved locally, offline after first load |
| Guided tutorial (5 scripted, labelled years) | Works |
| Pass-and-play, 2–4 seats with privacy curtain | Works |
| Online private rooms | **Beta.** Server and client run and pass the automated online suite locally. Not deployed anywhere and not yet tried on two physical devices, so it is not a released feature. |

Read `docs/test-report.md` for exactly what was verified and `docs/known-issues.md` for what was not.

## Run it

Requires Node ≥ 22.13 (developed on 24.11) and pnpm 12.

```bash
pnpm install
pnpm dev            # web app on http://localhost:5173 (solo and pass-and-play need nothing else)
pnpm dev:server     # game server on :8787, only needed for online rooms
```

The web dev server proxies `/api` and `/ws` to the game server, so online rooms work from the same origin.
To try online play from a phone on your Wi-Fi, open `http://<your-computer-ip>:5173`.

## Check it

```bash
pnpm typecheck          # strict TypeScript, all packages
pnpm lint               # ESLint (engine is barred from Date and Math.random)
pnpm content:validate   # Zod-validates the content pack
pnpm test               # engine rules, fuzzing, replay, AI matches, content (51 tests)
pnpm test:multiplayer   # real server + real sockets (14 tests)
pnpm test:e2e           # Playwright against the production build (8 tests; first run: npx playwright install chromium)
pnpm simulate 1000 12   # balance batch -> docs/balance-report-12.json
pnpm bench              # performance vs the spec budgets
pnpm build              # production web build in apps/web/dist
pnpm check              # everything above except e2e, simulate and bench
```

## Layout

```
packages/engine     pure deterministic rules: money, RNG, valuation, macro, loans, market, deals, phases, commands
packages/content    authored companies, properties, events, regimes + Zod schema
packages/ai         Grace / Alex / Victor: heuristic policies over seat observations
packages/protocol   wire messages and inbound validation shared by client and server
apps/web            React UI, local session host, IndexedDB saves (Dexie), PWA
apps/server         Node HTTP + WebSocket authoritative rooms on SQLite
tools               simulate, bench, replayAudit, contentValidate, makeGolden, makeIcons
tests               unit (fuzz/replay), multiplayer (server integration), e2e (browser), fixtures
docs                rules, architecture, hosting, privacy, dependencies, balance, test report, known issues, release checklist
```

## Deploying

See `docs/hosting.md`. Short version: `pnpm build`, then run `pnpm start:server` behind TLS with `STATIC_DIR` pointing at
`apps/web/dist`; one process serves the app, the API and the sockets from one origin. Environment variables are listed in
`.env.example`. Nothing here needs a paid service.
