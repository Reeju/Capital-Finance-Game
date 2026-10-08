import { useState } from 'react';
import {
  DISTRICT_NAMES, PAYOUT_CHOICES, availableUnits, bankAskBusiness, bankBidBusiness, currentMargin, defOf, effectivePayout, forecastGrowth, holdersOf,
  minTenderPrice, quoteCorpRefinance, quoteMarket, reinvestBoost, unitsOf, valueCompany,
} from '@capital/engine';
import { pct, signedPct, usd, usdShort } from '../format';
import { useGame } from '../game';
import { IntInput, KV, MoneyInput, Risk, Seg, Sheet } from '../kit';

export function CompanySheet({ id }: { id: string }) {
  const { s, me, act, open, prompt, why } = useGame();
  const def = defOf(s, id);
  const co = s.companies[id];
  const v = valueCompany(s, id);
  const g = forecastGrowth(s, id);
  const m = currentMargin(s, id);
  const mine = unitsOf(s, me, id);
  const free = availableUnits(s, me, id);
  const float = unitsOf(s, 'bank', id);
  const rescue = prompt?.kind === 'rescue';
  const here = s.players[me].district;
  const [side, setSide] = useState<'buy' | 'sell'>(rescue ? 'sell' : 'buy');
  const [qty, setQty] = useState(0);
  const [reinvest, setReinvest] = useState<number | null>(null);
  const [confirm, setConfirm] = useState(false);
  const controller = s.control[id];
  const iControl = controller === me;
  const atHq = here === def.district;
  const policyUsed = co.policyRound === s.round;
  const quote = qty > 0 && def.kind === 'public' ? quoteMarket(s, me, id, side === 'buy' ? qty : -qty, rescue) : null;
  const tradeBlock = rescue ? null : why('MarketOrder');
  const events = s.modifiers.filter((x) => [`sector:${def.sector}`, `company:${id}`].includes(x.target));

  return (
    <Sheet title={def.kind === 'public' ? `${def.ticker} · ${def.name}` : def.name} description={`${def.sector} · based in ${DISTRICT_NAMES[def.district]}${def.kind === 'private' ? ' · private business' : ''}`} onClose={() => open(null)}>
      <div className="stack">
        <div className="row"><Risk level={def.risk} />{controller ? <span className="chip gold">Controlled by {iControl ? 'you' : s.players[controller].name}</span> : <span className="chip">No controlling owner</span>}{co.arrears > 0 ? <span className="chip warn">⚠ In arrears: no dividends</span> : null}</div>

        <section className="card">
          <h3>Why it is priced this way</h3>
          <KV rows={[
            ['Profit used (EBIT)', usd(v.normalizedEBIT)],
            [`× multiple ${(v.multipleBps / 10_000).toFixed(2)} (base ${(def.baseMultiple / 10_000).toFixed(0)}, growth ${signedPct(v.growthAdj / 100, 2).replace('%', '')}, rates ${(v.rateAdj / 10_000).toFixed(2)}, risk ${(v.riskAdj / 10_000).toFixed(2)})`, usd(v.ev)],
            ['+ company cash', usd(co.cash)], ['− company debt', usd(co.debt + co.arrears)], ['= equity value', usd(v.equity), true],
            ...(def.kind === 'public' ? ([['Fair value per share', usd(v.fairPerShare)], [`× market mood ${(v.sentimentBps / 100).toFixed(0)}%`, usd(v.mark), true]] as [string, string, boolean?][]) : []),
          ]} />
          <p className="small muted">Company debt is already inside this value. Shareholders are never charged for it again.{def.kind === 'private' ? ' Private stakes are illiquid: the bank buys back at a discount.' : ''}</p>
        </section>

        <section className="card">
          <h3>Annual report</h3>
          <KV rows={[
            ['Revenue', usd(co.revenue)], ['Margin', pct(m.total)], ['Operating profit last year', usd(co.lastEBIT)],
            ['Corporate debt', co.debt ? `${usd(co.debt)} at ${pct(co.debtRate, 2)}` : 'None'],
            ['Payout policy', `${pct(effectivePayout(s, id), 0)} of profit`], ['Dividends last year', usd(co.lastDividend)],
            ['Expected growth', signedPct(g.total)],
          ]} />
          <p className="small muted">Growth = base {signedPct(g.base)} + economy {signedPct(g.gdp)} + confidence {signedPct(g.confidence)}{g.events ? ` + news ${signedPct(g.events)}` : ''}{g.reinvestment ? ` + reinvestment ${signedPct(g.reinvestment)}` : ''}, plus a yearly surprise of up to ±{def.risk}% and hidden sector demand. Margin = base {pct(m.base)}{m.commodity ? ` ${signedPct(m.commodity)} commodities` : ''}{m.events ? ` ${signedPct(m.events)} news` : ''}{m.synergy ? ` +${pct(m.synergy)} warehouse synergy` : ''}.</p>
          {events.length ? <ul className="feed">{events.map((e, i) => <li key={i}>News effect: {e.metric} {signedPct(e.delta)} for {e.roundsLeft} more year{e.roundsLeft > 1 ? 's' : ''} ({s.content.events.find((x) => x.id === e.eventId)?.headline})</li>)}</ul> : null}
        </section>

        <section className="card">
          <h3>Who owns it</h3>
          <div className="bar" aria-hidden="true">{holdersOf(s, id).map((h) => <span key={h} style={{ width: `${(unitsOf(s, h, id) / def.sharesOutstanding) * 100}%`, background: h === 'bank' ? '#3a4a66' : s.players[h].color }} />)}</div>
          <p className="small">{holdersOf(s, id).map((h) => `${h === 'bank' ? (def.kind === 'public' ? 'Free float' : 'Bank') : h === me ? 'You' : s.players[h].name} ${pct(Math.round((unitsOf(s, h, id) * 10_000) / def.sharesOutstanding), 2)}`).join(' · ')}</p>
          <p className="small muted">Control needs more than 50% ({(def.sharesOutstanding / 2 + 1).toLocaleString('en-US')} units). Exactly half is not control. Minority owners keep their pro-rata dividends.</p>
        </section>

        {def.kind === 'public' ? (
          <section className="card stack">
            <div className="between"><h3>Trade</h3><Seg label="Buy or sell" value={side} onChange={(x) => { setSide(x); setConfirm(false); }} options={rescue ? [['sell', 'Sell']] : [['buy', 'Buy'], ['sell', 'Sell']]} /></div>
            <IntInput id="qty" label={side === 'buy' ? `Shares to buy · float ${float.toLocaleString('en-US')}` : `Shares to sell · you can sell ${free.toLocaleString('en-US')}`} value={qty} onChange={(n) => { setQty(n); setConfirm(false); }} max={side === 'buy' ? float : mine} />
            {quote ? <KV rows={[['Market price', `${usd(quote.mark)} × ${qty.toLocaleString('en-US')}`], [`Spread ${pct(quote.spreadBps, 2)} + size impact ${pct(quote.impactBps, 2)}${rescue ? ' + 5% distress haircut' : ''}`, usd(quote.fee)], [side === 'buy' ? 'You pay' : 'You receive', usd(quote.total), true], ['Cash afterwards', usd(quote.cashAfter)]]} /> : <p className="small muted">Enter a quantity for an exact quote. Large orders cost more; the listed price itself does not move with your order.</p>}
            {tradeBlock ? <p className="small warn">{tradeBlock}</p> : null}
            {quote && confirm ? <p className="banner" role="status">{side === 'buy' ? 'Buy' : 'Sell'} {qty.toLocaleString('en-US')} {def.ticker} for exactly {usd(quote.total)}? Uses 1 AP. This quote is only good until the game state changes.</p> : null}
            <div className="row">
              <button className="primary grow" disabled={!quote || !!tradeBlock} onClick={() => { if (!confirm) return setConfirm(true); void act({ type: 'MarketOrder', companyId: id, shares: side === 'buy' ? qty : -qty }).then((ok) => { setConfirm(false); if (ok) setQty(0); }); }}>
                {confirm ? 'Confirm order' : `Review ${side} order${rescue ? '' : ' · 1 AP'}`}
              </button>
              {!rescue && mine * 2 <= def.sharesOutstanding ? <button disabled={!!why('Tender')} onClick={() => open({ kind: 'tender', id })}>Tender offer…</button> : null}
            </div>
            <p className="small muted">A tender must offer at least {usd(minTenderPrice(s, id))} a share (110% of market).</p>
          </section>
        ) : (
          <section className="card stack">
            <h3>Buy or sell the business</h3>
            {float === def.sharesOutstanding ? (
              <>
                <p>The bank sells 100% for <strong>{usd(bankAskBusiness(s, id))}</strong> (fair value + 5%).</p>
                <button className="primary" disabled={!atHq || !!why('BuyAsset')} onClick={() => { if (!confirm) return setConfirm(true); void act({ type: 'BuyAsset', asset: { kind: 'business', companyId: id } }).then(() => setConfirm(false)); }}>{confirm ? `Confirm: pay ${usd(bankAskBusiness(s, id))}` : 'Buy the business · 1 AP'}</button>
              </>
            ) : null}
            {mine > 0 ? (
              <>
                <p>The bank buys your {pct(free, 0)} stake back for <strong>{usd(bankBidBusiness(s, id, Math.max(free, 1), rescue))}</strong> ({rescue ? '60% distress' : s.macro.regime === 'crisis' ? '60% in a crisis' : '75%'} of fair value). Other players may pay more: propose a trade.</p>
                <button className="danger" disabled={free <= 0 || (!rescue && (!atHq || !!why('SellAsset')))} onClick={() => void act({ type: 'SellAsset', asset: { kind: 'business', companyId: id, units: free } })}>Sell stake to the bank{rescue ? '' : ' · 1 AP'}</button>
              </>
            ) : null}
            {!atHq && !rescue ? <p className="small warn">Go to {DISTRICT_NAMES[def.district]} to deal in this business.</p> : null}
          </section>
        )}

        {iControl && !rescue ? (
          <section className="card stack">
            <h3>Control room</h3>
            <p className="small muted">One policy action per company per year, at headquarters in {DISTRICT_NAMES[def.district]}, 1 AP. Company cash stays in the company; every owner benefits pro rata.</p>
            {policyUsed ? <p className="small warn">This year's policy action is used.</p> : !atHq ? <p className="small warn">Go to {DISTRICT_NAMES[def.district]} to act.</p> : null}
            <div className="row" role="group" aria-label="Payout ratio">
              {PAYOUT_CHOICES.map((x) => <button key={x} aria-pressed={co.payout === x} disabled={policyUsed || !atHq || !!why('SetPolicy') || co.payout === x} onClick={() => void act({ type: 'SetPolicy', companyId: id, payout: x })}>Pay out {x / 100}%</button>)}
            </div>
            <div className="row">
              <div className="grow"><MoneyInput id="reinvest" label={`Reinvest company cash ($) · has ${usdShort(co.cash)}`} value={reinvest} onChange={setReinvest} /></div>
              <button disabled={!reinvest || policyUsed || !atHq || !!why('Reinvest')} onClick={() => { if (reinvest) void act({ type: 'Reinvest', companyId: id, amount: reinvest }); }}>Reinvest{reinvest ? ` → +${pct(reinvestBoost(co.revenue, reinvest))} growth next year` : ''}</button>
            </div>
            {co.debt > 0 ? (
              <div className="row">
                <button disabled={policyUsed || !atHq || co.cash <= 0} onClick={() => void act({ type: 'CorpRepay', companyId: id, amount: Math.min(co.cash, co.debt + co.arrears) })}>Repay {usdShort(Math.min(co.cash, co.debt + co.arrears))} of company debt</button>
                <button disabled={policyUsed || !atHq || !quoteCorpRefinance(s, id).approved} title={quoteCorpRefinance(s, id).reasons[0]} onClick={() => void act({ type: 'CorpRefinance', companyId: id })}>Refinance at {pct(quoteCorpRefinance(s, id).rate, 2)}</button>
              </div>
            ) : null}
          </section>
        ) : null}
      </div>
    </Sheet>
  );
}
