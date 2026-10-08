import { useState } from 'react';
import { type Pledge, activeLoans, availableUnits, debtService, defOf, forecastIncome, mulBps, pledgeLendingValue, propertyPledged, quoteLoan, valuePortfolio } from '@capital/engine';
import { pct, usd, usdShort } from '../format';
import { useGame } from '../game';
import { KV, MoneyInput, Seg, Sheet } from '../kit';

export function BankSheet() {
  const { s, me, act, open, why } = useGame();
  const [principal, setPrincipal] = useState<number | null>(50_000_00);
  const [term, setTerm] = useState<3 | 5>(5);
  const [rateType, setRateType] = useState<'fixed' | 'floating'>('fixed');
  const [picked, setPicked] = useState<string[]>([]);
  const [confirm, setConfirm] = useState(false);
  const v = valuePortfolio(s, me);
  const options: { key: string; label: string; pledge: Pledge }[] = [
    ...s.content.companies.filter((c) => availableUnits(s, me, c.id) > 0).map((c) => {
      const pledge: Pledge = { kind: 'units', companyId: c.id, units: availableUnits(s, me, c.id) };
      return { key: c.id, label: `${c.kind === 'public' ? `${pledge.units.toLocaleString('en-US')} ${c.ticker}` : c.name}: lends ${usdShort(pledgeLendingValue(s, pledge))}`, pledge };
    }),
    ...s.content.properties.filter((p) => s.ownership.titles[p.id] === me && !propertyPledged(s, p.id)).map((p) => {
      const pledge: Pledge = { kind: 'property', propertyId: p.id };
      return { key: p.id, label: `${p.name}: lends ${usdShort(pledgeLendingValue(s, pledge))}`, pledge };
    }),
  ];
  const collateral = options.filter((o) => picked.includes(o.key)).map((o) => o.pledge);
  const q = principal ? quoteLoan(s, me, principal, term, rateType, collateral) : null;
  const block = why('Borrow');
  const loans = activeLoans(s).filter((l) => l.borrower === me && l.lender === 'bank');
  // Stress test: rates +2 points on floating debt and income down 30%.
  const income = forecastIncome(s, me, q ? Math.max(0, q.cashAfter) : undefined);
  const serviceNow = debtService(s, me) + (q ? q.firstPayment : 0);
  const stressedService = serviceNow + (q && rateType === 'floating' && principal ? mulBps(principal, 200) : 0) + activeLoans(s).filter((l) => l.borrower === me && l.rateType === 'floating').reduce((a, l) => a + mulBps(l.principal, 200), 0);
  const stressedCash = (q ? q.cashAfter : v.cash) + mulBps(Math.max(income, 0), 7000) - stressedService;

  return (
    <Sheet title="The bank" description="Debt is powerful and risky. Payments are due at every close, starting with this one." onClose={() => open(null)}>
      <div className="stack">
        <section className="card stack">
          <h3>New loan</h3>
          <MoneyInput id="principal" label="Borrow ($, minimum 10,000)" value={principal} onChange={(x) => { setPrincipal(x); setConfirm(false); }} />
          <div className="row"><Seg label="Term" value={term} onChange={setTerm} options={[[3, '3 years'], [5, '5 years']]} /><Seg label="Rate type" value={rateType} onChange={setRateType} options={[['fixed', 'Fixed'], ['floating', 'Floating']]} /></div>
          <p className="small muted">Fixed locks today's rate (+0.5%). Floating resets every year to the policy rate plus your spread.</p>
          {options.length ? (
            <fieldset style={{ border: 'none', padding: 0, margin: 0 }}>
              <legend className="small muted">Pledge collateral (raises your ceiling; pledged assets cannot be sold freely)</legend>
              {options.map((o) => (
                <label key={o.key} className="row" style={{ color: 'inherit' }}>
                  <input type="checkbox" style={{ width: 'auto', minHeight: 0 }} checked={picked.includes(o.key)} onChange={(e) => setPicked(e.target.checked ? [...picked, o.key] : picked.filter((k) => k !== o.key))} /> {o.label}
                </label>
              ))}
            </fieldset>
          ) : null}
          {q ? (
            <>
              <KV rows={[
                ['Rate', `${pct(q.rate, 2)} ${rateType}`], ['Debt ÷ assets after funding', pct(q.leverageBps)], ['Credit ceiling', `${usd(q.maxDebt)} (unsecured ${usdShort(q.unsecuredCeiling)} + collateral ${usdShort(q.collateralValue)})`],
                ['Yearly principal', usd(q.annualPrincipal)], ['First payment, at this close', usd(q.firstPayment), true], ['Cash right after funding', usd(q.cashAfter)],
              ]} />
              <div className={`banner ${stressedCash < 0 ? 'bad' : 'good'}`} role="status">
                <strong>Stress test.</strong> If income fell 30% and floating rates rose 2 points, this close you would have about {usd(Math.max(stressedCash, 0))} left{stressedCash < 0 ? ` and be short ${usd(-stressedCash)}. A missed payment starts a rescue window; unresolved, it ends in forced sales, a 50% write-down, −20 reputation and two years without bank credit.` : '.'}
              </div>
              {q.reasons.map((r) => <p key={r} className="small warn">✕ {r}</p>)}
            </>
          ) : <p className="small muted">Enter an amount for a quote.</p>}
          {block ? <p className="small warn">{block}</p> : null}
          {confirm && q ? <p className="banner" role="status">Borrow exactly {usd(principal ?? 0)} at {pct(q.rate, 2)} {rateType} for {term} years? First payment {usd(q.firstPayment)} at this close. Uses 1 AP.</p> : null}
          <button className="primary" disabled={!q?.approved || !!block} onClick={() => { if (!confirm) return setConfirm(true); if (principal) void act({ type: 'Borrow', principal, term, rateType, collateral }).then((ok) => { setConfirm(false); if (ok) open(null); }); }}>{confirm ? 'Sign the loan' : 'Review loan · 1 AP'}</button>
        </section>
        {loans.length ? (
          <section className="card stack">
            <h3>Refinance</h3>
            <p className="small muted">Replaces a loan with a new one at today's terms for a 1% fee. Collateral carries over; the bank re-approves everything first.</p>
            {loans.map((l) => {
              const rq = quoteLoan(s, me, l.principal + l.arrears, term, rateType, [], l);
              return (
                <div key={l.id} className="between">
                  <span className="small">{usd(l.principal + l.arrears)} at {pct(l.rate, 2)} → {pct(rq.rate, 2)} {rateType}, {term} yrs{rq.approved ? '' : ` · ${rq.reasons[0]}`}</span>
                  <button disabled={!rq.approved || !!why('Refinance')} onClick={() => void act({ type: 'Refinance', loanId: l.id, term, rateType })}>Refinance · 1 AP</button>
                </div>
              );
            })}
          </section>
        ) : null}
        <p className="small muted">Leverage now {pct(v.leverageBps)} · reputation {s.players[me].reputation} · credit tightness {s.macro.credit}/100 · policy rate {pct(s.macro.rate, 2)}. {loans.some((l) => l.collateral.length) ? `Secured on: ${loans.flatMap((l) => l.collateral).map((c) => (c.kind === 'units' ? defOf(s, c.companyId).name : c.propertyId)).join(', ')}.` : ''}</p>
      </div>
    </Sheet>
  );
}
