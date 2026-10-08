import { bankAskBusiness, bankAskProperty, forecastGrowth, propertyNOI, propertyValue, unitsOf, valueCompany } from '@capital/engine';
import { arrow, pct, signedPct, usd, usdShort } from '../format';
import { useGame } from '../game';

export function Market() {
  const { s, me, open } = useGame();
  const pubs = s.content.companies.filter((c) => c.kind === 'public');
  const privs = s.content.companies.filter((c) => c.kind === 'private');
  return (
    <div className="stack">
      <section>
        <h2>Exchange</h2>
        <p className="muted small">Prices are visible everywhere. Orders execute on Wall Street.</p>
        <div className="list">
          {pubs.map((c) => {
            const v = valueCompany(s, c.id);
            const gap = Math.round(((v.mark - v.fairPerShare) * 10_000) / Math.max(v.fairPerShare, 1));
            const mine = unitsOf(s, me, c.id);
            return (
              <button key={c.id} className="item" onClick={() => open({ kind: 'company', id: c.id })}>
                <span className="t">{c.ticker} <span className="muted" style={{ fontWeight: 400 }}>{c.name}</span></span>
                <span className="num t">{usd(v.mark)}</span>
                <span className="s">
                  <span className={gap > 300 ? 'down' : gap < -300 ? 'up' : ''}>{arrow(-gap)} {gap > 300 ? 'Rich' : gap < -300 ? 'Cheap' : 'Near fair'} ({signedPct(gap, 0)} vs fair {usd(v.fairPerShare)})</span>
                  {' · '}growth {signedPct(forecastGrowth(s, c.id).total)} · risk {c.risk}/5
                  {mine > 0 ? <> · <strong>you: {mine.toLocaleString('en-US')}</strong></> : null}
                  {s.control[c.id] ? <> · controlled by {s.control[c.id] === me ? 'you' : s.players[s.control[c.id] ?? '']?.name}</> : null}
                </span>
              </button>
            );
          })}
        </div>
      </section>
      <section>
        <h2>Private businesses</h2>
        <div className="list">
          {privs.map((c) => {
            const v = valueCompany(s, c.id);
            const bank = unitsOf(s, 'bank', c.id);
            const owners = s.seatOrder.filter((x) => unitsOf(s, x, c.id) > 0).map((x) => `${x === me ? 'you' : s.players[x].name} ${pct(unitsOf(s, x, c.id), 0)}`);
            return (
              <button key={c.id} className="item" onClick={() => open({ kind: 'company', id: c.id })}>
                <span className="t">{c.name}</span><span className="num t">{usdShort(v.equity)}</span>
                <span className="s">{bank === c.sharesOutstanding ? `Bank asks ${usdShort(bankAskBusiness(s, c.id))}` : owners.join(', ')} · profit {usdShort(s.companies[c.id].lastEBIT)}/yr · risk {c.risk}/5</span>
              </button>
            );
          })}
        </div>
      </section>
      <section>
        <h2>Property</h2>
        <div className="list">
          {s.content.properties.map((p) => {
            const owner = s.ownership.titles[p.id];
            const val = propertyValue(s, p.id);
            return (
              <button key={p.id} className="item" onClick={() => open({ kind: 'property', id: p.id })}>
                <span className="t">{p.name}</span><span className="num t">{usdShort(val)}</span>
                <span className="s">{owner === 'bank' ? `Bank asks ${usdShort(bankAskProperty(s, p.id))}` : owner === me ? 'Yours' : `Owned by ${s.players[owner]?.name}`} · rent after costs {usdShort(propertyNOI(s, p.id))}/yr ({pct(Math.round((propertyNOI(s, p.id) * 10_000) / Math.max(val, 1)))} yield)</span>
              </button>
            );
          })}
        </div>
      </section>
    </div>
  );
}
