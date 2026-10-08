# Hosting

Nothing is deployed. These are the steps for whoever does it; no paid service is required.

## Offline-only build (no server)
`pnpm build` and upload `apps/web/dist` to any static host over HTTPS (service workers need HTTPS or localhost).
Solo and pass-and-play work fully. The Online screen detects that no server answers and says online play is unavailable.
For a sub-path, build with `CAPITAL_BASE=/your/path/`.

## Single-origin deployment (recommended for online beta)
One Node process serves the web app, the API and the sockets.

```bash
pnpm install --frozen-lockfile
pnpm build
PORT=8787 DB_PATH=/var/lib/capital/capital.sqlite STATIC_DIR=$PWD/apps/web/dist pnpm start:server
```

Put it behind a TLS-terminating reverse proxy (Caddy, nginx, a platform's built-in proxy) that forwards WebSocket upgrades
on `/ws` and preserves the `Host` and `Origin` headers. Same-origin pages are always allowed; `ALLOWED_ORIGINS` is only for
extra origins. Seat cookies are `Secure` on any non-localhost host, so plain HTTP will not work outside localhost by design.

## Split deployment
Static web on one origin, server on another: build the web app with `VITE_SERVER_URL=https://server.example`, and start
the server with `ALLOWED_ORIGINS=https://web.example`. Cookies are `SameSite=Lax`, which browsers do **not** send on
cross-site `fetch`/WebSocket requests, so a split deployment only works when both hosts share a registrable domain
(for example `play.example.com` and `api.example.com`). Otherwise use the single-origin layout.

## Operations
- **Storage:** one SQLite file (WAL). Back up the file. Rooms untouched for 24 hours are deleted on the next start/sweep.
- **Restart:** rooms, seats, match state and the command log are restored. Turn clocks restart fresh when a player reconnects.
- **Audit:** `pnpm replay:audit /path/to/capital.sqlite` replays every room's command log and compares state hashes.
- **Scale:** exactly one process per database. Running two processes against one database, or two replicas behind a load
  balancer, is unsupported and would fork rooms. Multi-instance needs a PostgreSQL repository with row/advisory locks and
  pub/sub fan-out; that adapter is not written.
- **Node:** uses the built-in `node:sqlite` module (Node ≥ 22.13). On Node 24 it prints an ExperimentalWarning at start.
- **Limits:** 16 KB per message, 10 commands/s per seat (burst 20), 5 chat messages per 10 s, 5 room creations per hour per
  IP (in memory; behind a proxy every client shares the proxy's IP unless you terminate at the app or adapt the code to trust
  `X-Forwarded-For`).

## External blockers for a public online release
1. No hosting account or domain was available in this build session, so nothing is deployed.
2. The specification's gate requires two browsers on **different physical devices** completing a 12-round game. That has
   not been done. Until it has, keep the "beta" label.
