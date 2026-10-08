# Architecture

## One engine, three hosts
`packages/engine` is a pure TypeScript library with no React, browser, network or clock imports. Everything else calls:

```
createMatch(config, seed, content) -> MatchState
applyCommand(state, envelope)      -> { ok, state, events, error? }   // rejection returns the same state object
validateCommand(state, envelope)   -> { ok, error? }                  // dry run; works on seat observations
getObservation(state, seat)        -> { seat, state }                 // hidden fields blanked
listLegalActions(observation)      -> ActionDescriptor[]
quoteMarket / quoteLoan / quoteCorpRefinance                          // pure, never mutate
valuePortfolio(state, seat)        -> the valuation used by HUD and endgame alike
replay(initial, envelopes), stateHash(state), auditState(state)
```

Hosts: `LocalSession` in the browser (solo, pass-and-play), `Room` on the server (online), `tools/runner.ts` headless
(tests, simulation). All three build the same `CommandEnvelope` and go through `applyCommand`.

## Determinism
- Money is integer cents; rates are integer basis points; `mulDiv` rounds half away from zero with a BigInt fallback.
  `Money`/`Bps` are documented type aliases, not enforced brands (see known issues).
- RNG is Mulberry32, one stream per purpose (`macro`, `event`, `research`, `company:<id>`), each seeded from
  SHA-256(`seed:stream`) and stored with a draw counter. Rejected commands and quotes draw nothing.
- ESLint bars `Date` and `Math.random` inside the engine. Iteration is over sorted ids or the fixed seat order.
- `applyCommand` clones the state (journal and log are shared append-only), runs the handler, and on a `RuleError`
  discards the clone. Validation and execution are the same code path, so they cannot drift.

## Accounting
Every cash movement goes through `pay(from, to, amount, memo)`, which writes a balanced two-line journal entry.
Accounts: `player:<seat>`, `company:<id>`, `bank`, `economy`. Bank and economy are modelled sources and sinks and may go
negative; players and companies may not. `auditState` checks total cash is constant, every journal entry balances, units
sum to shares outstanding and no balance is negative. It runs after every step in tests and every 25th simulated match.
Ownership has one source of truth (`ownership.units`, `ownership.titles`); pledges and reservations are derived from open
loans, offers, contracts, listings, the auction and the tender, never stored twice.

## Phases
`turns` → `deals` → (`earnings`, obligations) → `distress` if anyone has arrears → `close` → next `open`.
`advance()` runs automatic steps until `currentPrompt()` names a seat. The prompt is derived, not stored:
turn seat, then open offers by id, then tender responders, then the auction's next bidder, then the rescue seat.

## Hidden information
Hidden: RNG streams, the pending regime and events, the current year's sector demand, each seat's research, proposals
between other seats, the journal. `getObservation` blanks all of it; the server only ever sends observations.
The AI is given the same observation type and nothing else.

## Web client
- `session/` — `GameSession` interface with `LocalSession` and `OnlineSession`. The UI reads one `View`
  (a seat observation plus connection facts) through `useSyncExternalStore`. No gameplay state lives in React.
- `persistence/db.ts` — Dexie. Each accepted command writes the new snapshot and a command-log row in one transaction, and
  refuses to overwrite a newer revision. A Web Lock makes a second tab read-only. Export is `{initial, commands, hash}` with
  an integrity hash; import validates with Zod, validates the content pack, **replays** the log and compares the hash.
- `ui/` — screens and sheets. Sheets use Radix Dialog for focus trapping. Charts are Recharts, lazy-loaded, each with a
  table alternative. The map is plain SVG with a native button list as its accessible twin.
- PWA — `vite-plugin-pwa` in `prompt` mode. A new build waits and is applied only from Home.

## Server
Node `http` + `ws` + `node:sqlite`, one process.
- **Seats.** Creating or joining a room issues a random 256-bit token in an HttpOnly, SameSite=Lax cookie named for the room
  (Secure except on localhost). Only its SHA-256 is stored. The socket upgrade requires the cookie and an allowed Origin.
- **One write path.** `Room.commit`: dedupe by `(room, commandId)` → rate limit → actor must equal the authenticated seat →
  `applyCommand` → one SQLite transaction writing the snapshot, the command with its acknowledgement and the room row →
  only then broadcast per-seat deltas and acknowledge. JavaScript's single thread plus synchronous SQLite is the per-match queue.
- **Clocks.** The server issues `TimeoutTurn` as actor `system`; the client schema does not contain that command. 90 s turns
  (5 min relaxed), 30 s responses, 2-minute reconnect grace twice per seat, then the room's agreed policy: pass or AI cover.
  All-human pause vote. If every human disconnects the room suspends; rooms idle for 24 h are deleted.
- **Messages.** `hello` → `welcome` (snapshot); `command` → `ack`; `delta` carries events and the seat projection without
  content/log (the client appends events); a revision gap triggers `requestSnapshot`.

### Why not Colyseus
The specification makes Colyseus the default and asks for a two-client spike before committing. **That spike was not run.**
The choice of `ws` was made on analysis: this game needs explicit per-seat projections (not synchronized room state),
cookie-based seat auth at the HTTP upgrade, and persistence inside the same transaction as the acknowledgement. With those
requirements Colyseus's schema sync would go unused and its reconnection tokens would sit beside, not replace, the seat
cookie. The resulting server is about 600 lines. If a spike later shows Colyseus removes real work (matchmaking, scaling),
`Room` is transport-agnostic (`Conn` is `{send, close}`) and can be hosted inside a Colyseus room.

## Extension points
Rules and content carry versions and every save pins both. New commands are new members of the `Command` union.
Later features named in the specification (issuance with subscription rights, mergers, research-card trading, PostgreSQL
with row locks and pub/sub for multiple instances, a hosted analytics provider) have no stub buttons in the UI.
