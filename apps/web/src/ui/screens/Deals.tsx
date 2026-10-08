import { useState } from 'react';
import {
  type TradeOffer, activeLoans, auctionAssetName, auctionAssetValue, availableUnits, defOf, describeBundle, distressPropertyPrice, distressUnitPrice, minBid,
  propertyPledged, spendable, totalArrears, valueCompany,
} from '@capital/engine';
import { pct, usd, usdShort } from '../format';
import { type Game, useGame } from '../game';
import { IntInput, KV, MoneyInput } from '../kit';

function describeOffer(g: Game, o: TradeOffer): string {
  const { s, me } = g;
  const name = (x: string) => (x === me ? 'you' : s.players[x].name);
  if (o.terms.kind === 'trade') return `${name(o.proposer)} give${o.proposer === me ? '' : 's'} ${describeBundle(s, o.give)} for ${describeBundle(s, o.receive)}`;
  if (o.terms.kind === 'loan') return `${name(o.terms.lender)} lend${o.terms.lender === me ? '' : 's'} ${name(o.terms.borrower)} ${usd(o.terms.principal)} at ${pct(o.terms.rate, 1)} for ${o.terms.term} year${o.terms.term > 1 ? 's' : ''}${o.terms.collateral.length ? ', secured' : ', unsecured'}`;
  return `${name(o.terms.buyer)} pay${o.terms.buyer === me ? '' : 's'} ${usd(o.terms.price)} for ${pct(o.terms.bps, 0)} of ${name(o.terms.seller)}'s ${defOf(s, o.terms.companyId).name} dividends for ${o.terms.rounds} year${o.terms.rounds > 1 ? 's' : ''}`;
}

function Rescue() {
  const g = useGame();
  const { s, me, act, open } = g;
  const due = totalArrears(s, me);
  const left = s.distress?.decisionsLeft ?? 0;
  const bankLoans = activeLoans(s).filter((l) => l.borrower === me && l.lender === 'bank');
  return (
    <section className="banner bad stack" role="alert">
      <h2>Rescue window</h2>
      <p>You could not pay <strong>{usd(due)}</strong> that fell due. You have <strong>{left}</strong> decision{left === 1 ? '' : 's'} to raise it. Cash you raise is applied automatically. Nobody is eliminated, whatever happens.</p>
      <div className="list">
        {s.content.companies.filter((c) => availableUnits(s, me, c.id) > 0).map((c) => {
          const n = availableUnits(s, me, c.id);
          const all = distressUnitPrice(s, c.id, n);
          const shares = c.kind === 'public' && all > due ? Math.min(n, Math.ceil((due * n) / Math.max(all, 1)) + 1) : n;
          return (
            <button key={c.id} className="item" onClick={() => void act(c.kind === 'public' ? { type: 'MarketOrder', companyId: c.id, shares: -shares } : { type: 'SellAsset', asset: { kind: 'business', companyId: c.id, units: n } })}>
              <span className="t">Sell {c.kind === 'public' ? `${shares.toLocaleString('en-US')} ${c.ticker}` : c.name}</span><span className="num">{usd(distressUnitPrice(s, c.id, shares))}</span>
              <span className="s">Distress price: {c.kind === 'public' ? '95% of market, less the spread' : '60% of fair value'}</span>
            </button>
          );
        })}
        {s.content.properties.filter((p) => s.ownership.titles[p.id] === me && !propertyPledged(s, p.id)).map((p) => (
          <button key={p.id} className="item" onClick={() => void act({ type: 'SellAsset', asset: { kind: 'property', propertyId: p.id } })}>
            <span className="t">Sell {p.name}</span><span className="num">{usd(distressPropertyPrice(s, p.id))}</span><span className="s">Distress price: 65% of fair value</span>
          </button>
        ))}
      </div>
      <div className="row">
        <button onClick={() => open({ kind: 'trade' })}>Offer a rescue deal…</button>
        <button onClick={() => open({ kind: 'loanOffer' })}>Ask a player for a loan…</button>
        {bankLoans.length ? <button onClick={() => open({ kind: 'bank' })}>Refinance…</button> : null}
      </div>
      <p className="small">If this is not resolved, the bank sells pledged collateral, then other assets at distress prices. Anything still unpaid is cut by 50% and becomes a two-year, 0% restructuring debt. You lose 20 reputation and bank credit for two years. If you end with nothing, a one-time $50,000 grant restarts you (deducted from your final score).</p>
      <button className="danger" onClick={() => void act({ type: 'Restructure' })}>Stop and let the bank restructure</button>
    </section>
  );
}

function Chat() {
  const { view, s, session } = useGame();
  const [text, setText] = useState('');
  const [muted, setMuted] = useState<string[]>([]);
  if (view.mode !== 'online' || !session.online) return null;
  const send = () => {
    if (text.trim()) session.online?.chat(text.trim());
    setText('');
  };
  return (
    <section className="card stack">
      <div className="between"><h3>Table talk</h3><span className="chip">Not binding</span></div>
      <ul className="feed" aria-live="polite">
        {view.chat.filter((c) => !muted.includes(c.from)).slice(-12).map((c, i) => <li key={i}><strong style={{ color: s.players[c.from]?.color }}>{s.players[c.from]?.name ?? c.from}:</strong> {c.text}</li>)}
        {view.chat.length === 0 ? <li className="muted">Promise anything. Only signed offers are enforced.</li> : null}
      </ul>
      <form className="row" onSubmit={(e) => { e.preventDefault(); send(); }}>
        <div className="grow"><label htmlFor="chat" className="sr-only">Message</label><input id="chat" maxLength={300} value={text} onChange={(e) => setText(e.target.value)} placeholder="Say something (not binding)" /></div>
        <button type="submit">Send</button>
      </form>
      <div className="row small">{s.seatOrder.filter((x) => x !== view.viewer && s.players[x].kind === 'human').map((x) => <button key={x} className="link" onClick={() => setMuted(muted.includes(x) ? muted.filter((m) => m !== x) : [...muted, x])}>{muted.includes(x) ? 'Unmute' : 'Mute'} {s.players[x].name}</button>)}</div>
    </section>
  );
}

export function Deals() {
  const g = useGame();
  const { s, me, act, open, prompt, view, session, why } = g;
  const [bid, setBid] = useState<number | null>(null);
  const [tenderQty, setTenderQty] = useState(0);
  const offers = Object.values(s.offers).filter((o) => o.status === 'open');
  const a = s.auction;
  const t = s.tender;
  const need = minBid(s);
  const myTurn = prompt?.kind === 'turn';
  const proposeBlock = prompt?.kind === 'rescue' ? null : why('ProposeTrade');
  const promptOffer = prompt?.kind === 'offer' ? s.offers[prompt.offerId] : null;

  return (
    <div className="stack">
      <h2>Deals</h2>
      {prompt?.kind === 'rescue' ? <Rescue /> : null}

      {promptOffer ? (
        <section className="banner stack" role="alert">
          <h3>Proposal from {s.players[promptOffer.proposer].name} <span className="chip gold">Binding if accepted</span></h3>
          <p>{describeOffer(g, promptOffer)}.</p>
          {promptOffer.note ? <p className="small muted">Note (not binding): “{promptOffer.note}”</p> : null}
          <p className="small">Your spendable cash: {usd(spendable(s, me))}. Accepting settles everything at once, or not at all.</p>
          <div className="row"><button className="primary grow" onClick={() => void act({ type: 'AcceptOffer', offerId: promptOffer.id })}>Accept</button><button className="grow" onClick={() => void act({ type: 'RejectOffer', offerId: promptOffer.id })}>Reject</button></div>
          {view.deadline ? <p className="small muted">No answer in time counts as a rejection.</p> : null}
        </section>
      ) : null}

      {prompt?.kind === 'tender' && t ? (
        <section className="banner stack" role="alert">
          <h3>Tender offer for {defOf(s, t.companyId).ticker}</h3>
          <p>{s.players[t.bidder].name} offers <strong>{usd(t.price)}</strong> a share (market {usd(valueCompany(s, t.companyId).mark)}) for up to {t.maxShares.toLocaleString('en-US')} shares, and needs {t.minShares.toLocaleString('en-US')} to succeed. You can tender up to {availableUnits(s, me, t.companyId).toLocaleString('en-US')}. If it is over-subscribed you sell a pro-rata part; if it fails you keep everything.</p>
          <IntInput id="tq" label="Shares to tender" value={tenderQty} onChange={(n) => setTenderQty(Math.min(n, availableUnits(s, me, t.companyId)))} max={availableUnits(s, me, t.companyId)} />
          <div className="row"><button className="primary grow" disabled={tenderQty < 1} onClick={() => void act({ type: 'TenderResponse', shares: tenderQty })}>Tender {tenderQty.toLocaleString('en-US')} for up to {usdShort(t.price * tenderQty)}</button><button className="grow" onClick={() => void act({ type: 'TenderResponse', shares: 0 })}>Keep my shares</button></div>
        </section>
      ) : null}

      {a ? (
        <section className={prompt?.kind === 'auction' ? 'banner stack' : 'card stack'} role={prompt?.kind === 'auction' ? 'alert' : undefined}>
          <h3>Auction: {auctionAssetName(s, a.asset)}</h3>
          <KV rows={[['Seller', a.seller === 'bank' ? 'The bank' : s.players[a.seller].name], ['Fair value estimate', usd(auctionAssetValue(s, a.asset))], ['Reserve', usd(a.reserve)], ['High bid', a.highBidder ? `${usd(a.highBid)} by ${a.highBidder === me ? 'you' : s.players[a.highBidder].name}` : 'None yet'], ['Passed', a.passed.map((x) => s.players[x].name).join(', ') || '—']]} />
          {prompt?.kind === 'auction' ? (
            <>
              <MoneyInput id="bid" label={`Your bid ($, minimum ${usd(need)}; you can spend ${usd(spendable(s, me))})`} value={bid ?? need} onChange={setBid} />
              <p className="small">Bids are escrowed from cash you have now. Loans you hope to get do not count. Passing is permanent for this auction.</p>
              <div className="row"><button className="primary grow" disabled={(bid ?? need) < need || (bid ?? need) > spendable(s, me)} onClick={() => void act({ type: 'Bid', amount: bid ?? need }).then(() => setBid(null))}>Bid {usd(bid ?? need)}</button><button className="grow" onClick={() => void act({ type: 'PassAuction' })}>Pass</button></div>
            </>
          ) : <p className="small muted">Bidding happens in the deals window after everyone's turn, in rotating order.</p>}
        </section>
      ) : null}

      {t && prompt?.kind !== 'tender' ? <section className="card"><h3>Open tender</h3><p className="small">{s.players[t.bidder].name} bids {usd(t.price)} a share for up to {t.maxShares.toLocaleString('en-US')} {defOf(s, t.companyId).ticker} (needs {t.minShares.toLocaleString('en-US')}). Holders answer in the deals window.</p></section> : null}

      <section className="card stack">
        <h3>Open proposals</h3>
        {offers.length === 0 ? <p className="muted small">None. Offers are answered in the deals window after all turns, and expire at year end.</p> : offers.map((o) => (
          <div key={o.id} className="between">
            <span className="small">{o.proposer === me ? `To ${s.players[o.recipient].name}` : `From ${s.players[o.proposer].name}`}: {describeOffer(g, o)}</span>
            {o.proposer === me && myTurn ? <button onClick={() => void act({ type: 'WithdrawOffer', offerId: o.id })}>Withdraw</button> : null}
          </div>
        ))}
      </section>

      {s.seatOrder.length > 1 && prompt?.kind !== 'offer' && prompt?.kind !== 'auction' && prompt?.kind !== 'tender' ? (
        <section className="card stack">
          <h3>Make an offer</h3>
          <p className="small muted">Signed offers are enforced by the rules. Anything you only say is a bluff waiting to happen. {myTurn ? 'Each proposal costs 1 AP; at most two open at once.' : ''}</p>
          {proposeBlock ? <p className="small warn">{proposeBlock}</p> : null}
          <div className="row">
            <button disabled={!!proposeBlock} onClick={() => open({ kind: 'trade' })}>Trade or gift…</button>
            <button disabled={!!proposeBlock} onClick={() => open({ kind: 'loanOffer' })}>Player loan…</button>
            <button disabled={!!proposeBlock} onClick={() => open({ kind: 'rights' })}>Dividend rights…</button>
            {myTurn ? <button disabled={!!why('ListAuction')} onClick={() => open({ kind: 'list' })}>List for auction…</button> : null}
          </div>
        </section>
      ) : null}

      <Chat />
      {view.mode === 'online' && view.room ? (
        <section className="card between">
          <span className="small">{view.room.paused ? 'Paused: clocks are stopped.' : `Pause needs every connected player (${view.room.pauseVotes.length} voted).`}</span>
          <button onClick={() => session.online?.pauseVote(!view.room?.pauseVotes.includes(me))}>{view.room.pauseVotes.includes(me) ? 'Withdraw pause vote' : 'Vote to pause'}</button>
        </section>
      ) : null}
    </div>
  );
}
