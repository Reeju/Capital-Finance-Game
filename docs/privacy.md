# Privacy and data

Capital has no accounts, no ads and no payments.

## Offline modes
Saved matches and settings are stored in your browser's IndexedDB on your device. Nothing is sent anywhere.
Settings → Saved matches lets you export any match as a file and delete everything.

## Online rooms (beta)
- The server stores, per room: seat names and colours you typed, the room settings, the match state, and the list of
  accepted game commands. Rooms idle for 24 hours are deleted with all of that.
- Your seat is held by a random token in an HttpOnly cookie for that room. Only a hash of it is stored on the server.
- Chat is relayed to the room and not stored. It is limited to 300 characters and can be muted per player on your device.
- Other players can see public game facts: names, positions, balances, holdings, accepted trades. They cannot see your
  research results or proposals you exchange with someone else; the server never sends those to other seats.
- Server logs record room codes and error codes, never message contents, tokens, chat or research.

## Analytics
Off by default. This build has no analytics server. If you switch it on, a list of at most 200 anonymous events (for
example "match started") is kept on your device only; switching it off deletes the list. It never contains names, chat,
research or holdings.

## Fiction
All companies, tickers, prices and people are invented. The game simplifies economics heavily (no taxes, yearly steps) and
is not financial advice.
