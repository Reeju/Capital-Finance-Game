import { Suspense, lazy, useState } from 'react';
import {
  activeLoans, contractValue, debtService, defOf, forecastIncome, loanService, pledgedUnits, propertyValue, unitValue, unitsOf, valueCompany, valuePortfolio,
} from '@capital/engine';
import { pct, usd, usdShort } from '../format';
import { useGame } from '../game';
import { KV, MoneyInput, Seg } from '../kit';

const TrendChart = lazy(() => import('../Charts'));

export function Portfolio() {
  const { s, me, open, act, prompt } = useGame();
  const [tab, setTab] = useState<'holdings' | 'pnl' | 'balance' | 'cash'>('holdings');
  const [repay, setRepay] = useState<{ id: string; amount: number | null } | null>(null);
  const p = s.players[me];
  const v = valuePortfolio(s, me);
  const loans = activeLoans(s).filter((l) => l.borrower === me);
  const lent = activeLoans(s).filter((l) => l.lender === me);
  const service = debtService(s, me);
  const income = forecastIncome(s, me);
  const last = p.history[p.history.length - 1];
  const canAct = prompt?.kind === 'turn' || prompt?.kind === 'rescue';

  return (
    <div className="stack">
      <div className="between"><h2>Portfolio</h2><Seg label="Portfolio view" value={tab} onChange={setTab} options={[['holdings', 'Holdings'], ['pnl', 'P&L'], ['balance', 'Balance'], ['cash', 'Cash']]} /></div>

      {tab === 'holdings' ? (
        <>
          <div className="list">
            {s.content.companies.filter((c) => unitsOf(s, me, c.id) > 0).map((c) => {
              const u = unitsOf(s, me, c.id);
              const pos = p.positions[c.id];
              return (
                <button key={c.id} className="item" onClick={() => open({ kind: 'company', id: c.id })}>
                  <span className="t">{c.kind === 'public' ? `${u.toLocaleString('en-US')} ${c.ticker}` : `${pct(u, 0)} of ${c.name}`}</span><span className="num t">{usdShort(unitValue(s, c.id, u))}</span>
                  <span className="s">{c.kind === 'public' ? `${usd(valueCompany(s, c.id).mark)} a share` : 'Private, at fair value'}{s.control[c.id] === me ? ' · you control it' : ''}{pledgedUnits(s, me, c.id) > 0 ? ' · pledged as collateral' : ''}{pos ? ` · income so far ${usdShort(pos.income)}` : ''}</span>
                </button>
              );
            })}
            {s.content.properties.filter((d) => s.ownership.titles[d.id] === me).map((d) => (
              <button key={d.id} className="item" onClick={() => open({ kind: 'property', id: d.id })}>
                <span className="t">{d.name}</span><span className="num t">{usdShort(propertyValue(s, d.id))}</span><span className="s">Rent after costs {usdShort(s.properties[d.id].lastNOI)} last year</span>
              </button>
            ))}
            {v.publicShares + v.privateEquity + v.property === 0 ? <p className="muted">Nothing but cash so far. Cash is safe; it just does not grow much.</p> : null}
          </div>
          <section className="card stack">
            <h3>Debt ladder</h3>
            {loans.length === 0 ? <p className="muted small">No debt.</p> : loans.map((l) => {
              const svc = loanService(s, l);
              return (
                <div key={l.id} className="stack">
                  <div className="between">
                    <span><strong>{usd(l.principal + l.arrears)}</strong> <span className="muted small">to {l.lender === 'bank' ? 'the bank' : s.players[l.lender].name} · {pct(l.rate, 2)} {l.rateType}{l.status === 'restructured' ? ' · restructured' : ''}</span></span>
                    <button disabled={!canAct} onClick={() => setRepay({ id: l.id, amount: Math.min(l.principal + l.arrears, p.cash) })}>Repay</button>
                  </div>
                  <p className="small muted">Due this close: {usd(svc.total)} ({usd(svc.interest)} interest + {usd(svc.principal)} principal{svc.arrears ? ` + ${usd(svc.arrears)} arrears` : ''}) · final payment year {l.maturityRound}{l.collateral.length ? ` · secured on ${l.collateral.map((c) => (c.kind === 'units' ? defOf(s, c.companyId).name : s.content.properties.find((x) => x.id === c.propertyId)?.name)).join(', ')}` : ' · unsecured'}</p>
                  {repay?.id === l.id ? (
                    <div className="row">
                      <div className="grow"><MoneyInput id={`repay-${l.id}`} label="Repay principal ($) · 1 AP" value={repay.amount} onChange={(amount) => setRepay({ id: l.id, amount })} /></div>
                      <button className="primary" disabled={!repay.amount} onClick={() => { if (repay.amount) void act({ type: 'Repay', loanId: l.id, amount: repay.amount }).then((ok) => { if (ok) setRepay(null); }); }}>Pay {repay.amount ? usd(repay.amount) : ''}</button>
                    </div>
                  ) : null}
                </div>
              );
            })}
            {lent.map((l) => <p key={l.id} className="small">You are owed <strong>{usd(l.principal + l.arrears)}</strong> by {s.players[l.borrower].name} at {pct(l.rate, 1)}{l.status === 'restructured' ? ' (restructured: counted at 50%)' : ''}.</p>)}
            {s.contracts.filter((c) => c.buyer === me || c.seller === me).map((c) => <p key={c.id} className="small">Dividend rights: {c.buyer === me ? 'you receive' : 'you pay'} {pct(c.bps, 0)} of {c.seller === me ? 'your' : `${s.players[c.seller].name}'s`} {defOf(s, c.companyId).name} dividends for {c.roundsLeft} more year{c.roundsLeft > 1 ? 's' : ''} (valued {usdShort(contractValue(s, c))}).</p>)}
          </section>
          <section className="card">
            <h3>Cash forecast for this close</h3>
            <KV rows={[['Cash now', usd(p.cash)], ['Expected income (not guaranteed)', `+ ${usd(Math.max(income, 0))}`], ['Debt payments due', `− ${usd(service)}`], ['Roughly after close', usd(p.cash + income - service), true]]} />
          </section>
        </>
      ) : null}

      {tab === 'pnl' ? (
        <section className="card stack">
          <h3>Profit &amp; loss</h3>
          <p className="muted small">Operating income is cash you actually received. Valuation movement is unrealized until you sell. Buying assets and repaying principal are not expenses.</p>
          <table>
            <thead><tr><th scope="col">Year</th><th scope="col">Income received</th><th scope="col">Net worth</th><th scope="col">Change</th></tr></thead>
            <tbody>
              {p.history.map((h, i) => <tr key={h.round}><td>{h.round}</td><td>{usdShort(h.income)}</td><td>{usdShort(h.netWorth)}</td><td>{usdShort(h.netWorth - (i ? p.history[i - 1].netWorth : 500_000_00))}</td></tr>)}
              {p.history.length === 0 ? <tr><td colSpan={4} className="muted">Your first annual results appear after this year's close.</td></tr> : null}
            </tbody>
          </table>
          {last ? <p className="small">Last year: income {usd(last.income)}; the rest of the {usd(last.netWorth - (p.history[p.history.length - 2]?.netWorth ?? 500_000_00))} change was valuation, trading costs and interest.</p> : null}
        </section>
      ) : null}

      {tab === 'balance' ? (
        <section className="card stack">
          <h3>Balance sheet</h3>
          <KV rows={[
            ['Cash', usd(v.cash)], ['Public shares (at market)', usd(v.publicShares)], ['Private businesses (fair value)', usd(v.privateEquity)], ['Property (fair value)', usd(v.property)],
            ['Loans you made', usd(v.receivables)], ['Dividend rights', usd(v.rights)], ['Total assets', usd(v.assets), true],
            ['Loan principal', usd(v.loanPrincipal)], ['Arrears', usd(v.arrears)], ['Total liabilities', usd(v.liabilities), true], ['Net worth', usd(v.netWorth), true],
          ]} />
          <p className="small muted">Company debt lives inside each company's value. It is never subtracted from you a second time. Leverage: {pct(v.leverageBps)} of assets. Reputation {p.reputation} adds {usd(v.bonus)} to the final score{v.grants ? `; restart grants of ${usd(v.grants)} are deducted` : ''}.</p>
        </section>
      ) : null}

      {tab === 'cash' ? (
        <section className="card stack">
          <h3>Net worth, debt and cash by year</h3>
          {p.history.length > 1 ? (
            <Suspense fallback={<p className="muted">Loading chart…</p>}>
              <TrendChart label="Line chart of your net worth, debt and cash by year. The same numbers are in the table below." data={p.history.map((h) => ({ round: h.round, netWorth: h.netWorth, debt: h.debt, cash: h.cash }))}
                series={[{ key: 'netWorth', name: 'Net worth', color: '#f2c14e' }, { key: 'debt', name: 'Debt', color: '#ff9d8a', dashed: true }, { key: 'cash', name: 'Cash', color: '#7fd1ae' }]} />
            </Suspense>
          ) : <p className="muted small">The chart appears after two closes.</p>}
          <table>
            <thead><tr><th scope="col">Year</th><th scope="col">Cash</th><th scope="col">Debt</th><th scope="col">Net worth</th></tr></thead>
            <tbody>{p.history.map((h) => <tr key={h.round}><td>{h.round}</td><td>{usdShort(h.cash)}</td><td>{usdShort(h.debt)}</td><td>{usdShort(h.netWorth)}</td></tr>)}</tbody>
          </table>
        </section>
      ) : null}
    </div>
  );
}
