import { useState } from 'react';
import { DISTRICT_NAMES, UPGRADE_COST, bankAskProperty, bankBidProperty, capRate, propDefOf, propertyNOI, propertyPledged, propertyValue } from '@capital/engine';
import { pct, usd } from '../format';
import { useGame } from '../game';
import { KV, Sheet } from '../kit';

export function PropertySheet({ id }: { id: string }) {
  const { s, me, act, open, prompt, why } = useGame();
  const def = propDefOf(s, id);
  const p = s.properties[id];
  const owner = s.ownership.titles[id];
  const noi = propertyNOI(s, id);
  const value = propertyValue(s, id);
  const here = s.players[me].district === def.district;
  const rescue = prompt?.kind === 'rescue';
  const [confirm, setConfirm] = useState(false);
  const inAuction = s.auction?.asset.kind === 'property' && s.auction.asset.propertyId === id;
  const occMods = s.modifiers.filter((m) => m.metric === 'occupancy');
  const upgradedValue = Math.round(((Math.round(((p.grossRent + 4_000_00) * p.occupancy) / 10_000) - p.expense - 1_000_00) * 10_000) / capRate(s, id));

  return (
    <Sheet title={def.name} description={`Property title in ${DISTRICT_NAMES[def.district]} · ${owner === 'bank' ? 'owned by the bank' : owner === me ? 'yours' : `owned by ${s.players[owner].name}`}`} onClose={() => open(null)}>
      <div className="stack">
        <section className="card">
          <h3>Why it is worth this</h3>
          <KV rows={[
            ['Gross rent', usd(p.grossRent)], [`× occupancy ${pct(p.occupancy)}`, usd(Math.round((p.grossRent * p.occupancy) / 10_000))], ['− running costs', usd(p.expense)],
            ['= net rent (NOI)', usd(noi), true], [`÷ cap rate ${pct(capRate(s, id), 2)}`, ''], ['= fair value', usd(value), true],
          ]} />
          <p className="small muted">Cap rates rise with interest rates and tight credit, pushing values down. Occupancy follows confidence and growth{occMods.length ? `; news is adding ${pct(occMods.reduce((a, m) => a + m.delta, 0))}` : ''}. There is no separate “appreciation”: value is only rent and rates. Rent is paid once a year to the owner, never for visiting.</p>
        </section>
        {owner === 'bank' ? (
          <section className="card stack">
            <p>{inAuction ? 'This is this year\'s auction lot. Bid in the deals window.' : <>The bank sells the title for <strong>{usd(bankAskProperty(s, id))}</strong> (fair value + 5%).</>}</p>
            {!inAuction ? <button className="primary" disabled={!here || !!why('BuyAsset')} onClick={() => { if (!confirm) return setConfirm(true); void act({ type: 'BuyAsset', asset: { kind: 'property', propertyId: id } }).then(() => setConfirm(false)); }}>{confirm ? `Confirm: pay ${usd(bankAskProperty(s, id))}` : 'Buy the title · 1 AP'}</button> : null}
            {!here ? <p className="small warn">Go to {DISTRICT_NAMES[def.district]} to buy.</p> : null}
          </section>
        ) : null}
        {owner === me ? (
          <section className="card stack">
            <h3>Manage</h3>
            <p className="small">Upgrade for {usd(UPGRADE_COST)}: +$4,000 rent and +$1,000 costs a year, forever. Value would become about {usd(upgradedValue)} (now {usd(value)}). Upgrades: {p.upgrades}/{def.upgradesMax}.</p>
            <div className="row">
              <button disabled={rescue || !here || p.upgrades >= def.upgradesMax || !!why('Upgrade')} onClick={() => void act({ type: 'Upgrade', propertyId: id })}>Upgrade · 1 AP</button>
              <button className="danger" disabled={!rescue && (!here || !!why('SellAsset'))} onClick={() => void act({ type: 'SellAsset', asset: { kind: 'property', propertyId: id } })}>Sell to the bank for {usd(bankBidProperty(s, id, rescue))}</button>
            </div>
            {propertyPledged(s, id) ? <p className="small warn">Pledged as collateral: a sale must raise enough to repay that loan.</p> : null}
          </section>
        ) : null}
      </div>
    </Sheet>
  );
}
