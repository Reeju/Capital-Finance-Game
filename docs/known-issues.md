# Known issues and deviations from the specification

## Deviations
1. **Online stack.** `ws` + `node:sqlite` instead of Colyseus, and the Colyseus spike the specification asks for was not
   run. Reasoning in architecture.md.
2. **No PostgreSQL adapter.** SQLite, single process only.
3. **`Money`/`Bps` are not enforced brands.** They are optional-brand aliases: they document units but the compiler will
   not stop a plain number being passed. Integer-ness is enforced at runtime at every command boundary.
4. **Deadlines after a server restart** start fresh rather than resuming the persisted timestamp.
5. **Deltas carry the full seat projection** (without content and log), not a patch, and there is no projection hash.
   A revision gap triggers a snapshot request. Largest delta measured: 28 KB at the end of a 4-seat Standard match.
6. **Not implemented from the contract rules:** assigning a player loan to a third party; lender-approved assumption of an
   encumbered asset by the buyer (only release-from-proceeds exists); an atomic counter-offer (reject and propose again);
   funding company growth from personal cash; unit issuance.
7. **Research** reads the *current* year's hidden sector demand (resolved at this year's close), kept for two years.
8. **Quiet Year** is exempt from the no-repeat-within-three-years rule, otherwise a real macro event would be forced almost
   every year.
9. **Margin call.** "Secured collateral value < principal/1.25" is implemented as: the excess principal is called at the
   next close and becomes arrears if unpaid.
10. **Order-size impact** accumulates per seat per company per year, so splitting an order does not avoid it and acting
    later in the turn order does not cost more.
11. **Analytics** is a local queue with five event types and no network sink. The Identity/Entitlements/ShareRenderer
    provider interfaces named in the specification were not created; there is nothing behind them yet.
12. **Art and audio.** No asset packs; CSS, one SVG icon and one synthesised tone.
13. **Investment attribution** on the results screen ignores assets moved by player-to-player trades.
14. **Host transfer** exists in the lobby only (the server is authoritative during play, so no migration is needed).
15. **Tutorial** teaches through a coach card for years 1–5; it does not gate or force actions.
16. **Local AI speed.** `?aiDelay=<ms>` in the URL changes the AI's thinking pause (used by tests).

## Balance flags (see balance.md)
- Leveraged control play (Victor) wins about 75% of mixed AI line-ups.
- The first seat still wins about 60% of mirror AI matches.
- ByteForge reaches the $1,000 price ceiling in about two thirds of Standard matches.
- Base growth was scaled to 60% of the specification's table and CloudForge's multiple raised to 7 to get this far.

## Operational
- `node:sqlite` prints an ExperimentalWarning on Node 24.
- Room-creation rate limiting is per remote IP in memory; behind a proxy it sees the proxy.
- A split web/server deployment only works within one registrable domain (SameSite=Lax cookies).
- The state snapshot written per command grows with the journal (about 330 KB at the end of a Standard match).

## Untested
Listed at the end of test-report.md. The important ones: no physical devices, no screen readers, no hosted server.
