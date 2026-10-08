import { REGIME_NAMES, cashInterestRate, valuePortfolio } from '@capital/engine';
import { pct, usd, usdShort } from '../format';
import { useGame } from '../game';
import { KV, Sheet } from '../kit';
import { Rules } from '../rules';

export function HelpSheet({ onClose }: { onClose: () => void }) {
  return <Sheet title="Rules in two minutes" onClose={onClose}><Rules /></Sheet>;
}

export function AccountsSheet() {
  const { s, me, open } = useGame();
  const v = valuePortfolio(s, me);
  const p = s.players[me];
  return (
    <Sheet title="Your accounts" description="The same valuation decides the winner at the end." onClose={() => open(null)}>
      <div className="stack">
        <KV rows={[
          ['Cash', usd(v.cash)], ['Public shares', usd(v.publicShares)], ['Private businesses', usd(v.privateEquity)], ['Property', usd(v.property)],
          ['Loans you made', usd(v.receivables)], ['Dividend rights', usd(v.rights)], ['Assets', usd(v.assets), true],
          ['Debt principal', usd(v.loanPrincipal)], ['Arrears', usd(v.arrears)], ['Net worth', usd(v.netWorth), true],
          [`Reputation bonus (${p.reputation} × $100)`, usd(v.bonus)], ['Restart grants deducted', usd(v.grants)], ['Adjusted net worth (score)', usd(v.adjusted), true],
        ]} />
        <p className="small muted">Income last year: {usd(p.lastIncome)} (dividends, rent, interest and contract income actually received). Idle cash earns {pct(cashInterestRate(s), 2)} on the lowest balance you held during the year. Debt is {pct(v.leverageBps)} of assets.</p>
      </div>
    </Sheet>
  );
}

export function NewsSheet() {
  const { s, open } = useGame();
  const m = s.macro;
  const feed = s.log.filter((e) => e.type !== 'moved' && e.type !== 'research_done').slice(-40).reverse();
  return (
    <Sheet title={`Year ${s.round}: ${REGIME_NAMES[m.regime]}`} description={s.headline} onClose={() => open(null)}>
      <div className="stack">
        <section className="card">
          <h3>The economy</h3>
          <KV rows={[['GDP growth', pct(m.gdp)], ['Inflation', pct(m.inflation)], ['Policy rate', pct(m.rate, 2)], ['Consumer confidence', `${m.confidence}/100`], ['Credit tightness', `${m.credit}/100`], ['Commodity index', String(m.commodity)], ['Market mood', `${(m.sentiment / 100).toFixed(0)}%`]]} />
        </section>
        <section className="card"><h3>Why it moved</h3><ul className="feed">{m.explanations.map((x) => <li key={x}>{x}</li>)}</ul>
          <p className="small muted">Each year the economy drifts halfway toward its regime's typical values. Regimes change by weighted chance; nobody, including the AI players, can see next year's news.</p></section>
        {s.auction ? <section className="card"><h3>This year's auction</h3><p>{s.log.filter((e) => e.type === 'auction_announced').slice(-1)[0]?.text}</p></section> : null}
        <section className="card"><h3>Public record</h3><ul className="feed">{feed.map((e, i) => <li key={i}><span className="muted">Y{e.round}</span> {e.text}</li>)}</ul></section>
      </div>
    </Sheet>
  );
}

/** Annual report shown when a new year opens: last year's results for this player, then this year's news. */
export function ReportSheet() {
  const { s, me, open } = useGame();
  const p = s.players[me];
  const last = p.history[p.history.length - 1];
  const prev = p.history[p.history.length - 2];
  const y = s.round - 1;
  const results = s.log.filter((e) => e.round === y && ['company_results', 'payment_missed', 'restructured', 'restart_grant', 'auction_won', 'tender_filled', 'tender_failed', 'trade_executed', 'control_acquired'].includes(e.type));
  return (
    <Sheet title={`Annual report: year ${y}`} description={`Now opening year ${s.round}: ${s.headline}`} onClose={() => open(null)}>
      <div className="stack">
        {last ? (
          <section className="card">
            <h3>Your year</h3>
            <KV rows={[['Income received', usd(last.income)], ['Cash at close', usd(last.cash)], ['Debt at close', usd(last.debt)], ['Net worth', usd(last.netWorth), true], ['Change in net worth', `${last.netWorth - (prev?.netWorth ?? 500_000_00) >= 0 ? '▲ +' : '▼ '}${usdShort(last.netWorth - (prev?.netWorth ?? 500_000_00))}`]]} />
          </section>
        ) : null}
        <section className="card"><h3>Year {s.round} news</h3><p><strong>{REGIME_NAMES[s.macro.regime]}.</strong> {s.headline}</p><ul className="feed">{s.log.filter((e) => e.round === s.round && e.type === 'news_event').map((e, i) => <li key={i}>{e.text}</li>)}{s.macro.explanations.slice(0, 3).map((x) => <li key={x} className="muted">{x}</li>)}</ul></section>
        <section className="card"><h3>What happened in year {y}</h3><ul className="feed">{results.map((e, i) => <li key={i}>{e.text}</li>)}</ul></section>
        <button className="primary" onClick={() => open(null)}>Start year {s.round}</button>
      </div>
    </Sheet>
  );
}
