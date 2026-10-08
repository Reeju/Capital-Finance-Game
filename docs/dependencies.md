# Dependencies

Chosen 8 October 2026; exact versions are pinned in `pnpm-lock.yaml`. Licences read from each package's `package.json`.
`pnpm install` reported the lockfile passing pnpm's supply-chain policy check; no separate advisory audit was run.

| Package | Version | Licence | Used for | Why |
|---|---|---|---|---|
| react, react-dom | 19.3.0 | MIT | UI | Specified stack. State via `useState`/`useSyncExternalStore`; no store library. |
| vite, @vitejs/plugin-react | 8.3.3 / 6.1.2 | MIT | Build and dev server | Specified stack. |
| vite-plugin-pwa (+ workbox-window) | 2.0.0 / 7.4.1 | MIT | Manifest, service worker, prompt-mode updates | Avoids a hand-written cache layer. |
| dexie | 4.4.6 | Apache-2.0 | IndexedDB transactions and versioned stores | Avoids a hand-written IndexedDB wrapper. |
| zod | 4.6.5 | MIT | Validation at boundaries: content pack, wire messages, save import | One schema source per boundary. |
| recharts | 3.10.1 | MIT | Net-worth charts (lazy chunk, ~106 KB gzip) | Avoids a bespoke chart/axis/tooltip layer. |
| @radix-ui/react-dialog | 1.2.0 | MIT | Sheet/dialog focus trap and dismissal | Only primitive used; everything else is native HTML. |
| ws | 8.22.0 | MIT | WebSocket server (and test client) | Small, maintained; see architecture.md for why not Colyseus. |
| node:sqlite | built into Node | — | Server persistence | No native add-on to compile. Experimental warning on Node 24. |
| typescript | 6.0.3 | Apache-2.0 | Type checking | Pinned to 6.x because typescript-eslint 8.71 does not support TypeScript 7. |
| vitest | 5.0.3 | MIT | Unit and integration tests | |
| fast-check | 4.10.2 | MIT | Property-based command fuzzing | Dev only. |
| @playwright/test | 1.63.0 | Apache-2.0 | Browser end-to-end tests | Dev only; downloads Chromium headless shell. |
| eslint, typescript-eslint, eslint-plugin-react-hooks | 10.12.0 / 8.71.1 / 7.1.1 | MIT | Lint | |
| tsx | 4.23.15 | MIT | Runs the server and tools from TypeScript | |

Not used, deliberately: a game-rendering engine (seven nodes are plain SVG), a state-management library, an ORM, a UI kit,
Colyseus (see architecture.md), any paid or cloud service.

**Art and audio.** No third-party art or audio packs are bundled. The icon is an original SVG (rasterised by
`tools/makeIcons.mjs`), the UI is CSS, and the single turn tone is synthesised with Web Audio. The Kenney packs suggested
in the specification were not selected; if art is added later, record each pack's licence here.

Custom on purpose: the rules engine, economic model, content, RNG/hash, seat projection and the server's command path.
