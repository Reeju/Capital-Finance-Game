import { useState } from 'react';
import { type DistrictId, type Sector, DISTRICTS, DISTRICT_NAMES, adjacent, bankAskBusiness, bankAskProperty, researchDistricts, unitsOf } from '@capital/engine';
import { usdShort } from '../format';
import { useGame } from '../game';

const POS: Record<DistrictId, [number, number]> = {
  wallstreet: [80, 50], tech: [290, 50], financial: [80, 160], industrial: [290, 160], downtown: [80, 270], realestate: [220, 270], energy: [360, 270],
};
const BLURB: Record<DistrictId, string> = {
  financial: 'The bank: loans, refinancing and long lunches.', wallstreet: 'The exchange: buy, sell, tender, research.', industrial: 'Factories and freight.',
  tech: 'Software and big promises.', energy: 'Power and utilities.', realestate: 'Property titles.', downtown: 'Shops, health and a hotel.',
};

function Coach() {
  const { view, s, session } = useGame();
  if (!view.tutorial || view.coachDismissed || s.round > 5) return null;
  const steps = [
    ['Where you stand matters', 'You get 3 action points (AP) a year. Moving one district costs 1 AP. Shares trade on Wall Street, next door. Walk there and buy a few. You do not have to invest everything: cash is what lets you survive a bad year.'],
    ['What is a company worth?', 'Open any company in Market. Its price is profit × a multiple × the market\'s mood. “Cheap” means the price is below the fair estimate; “rich” means above. Neither is a promise.'],
    ['Leverage cuts both ways', 'The bank is here in Financial. A loan lets you buy more than you have, and the payments come due at every close, good year or bad. Open the bank and read the stress test before you sign.'],
    ['A warning, not a forecast', 'Inflation jumped. Central banks tend to answer with higher rates, and higher rates squeeze share prices, tech most of all. In this tutorial the next step is scripted; in a real match it is only a risk.'],
    ['The rate shock', 'Rates rose and prices fell. Check your debt payments and whether you still like what you own. From next year the news is no longer scripted. Good luck.'],
  ];
  const [title, body] = steps[s.round - 1];
  return (
    <aside className="coach" aria-label="Tutorial">
      <div className="between"><h3>{title}</h3><button className="link" onClick={() => session.dismissCoach()}>Hide tips</button></div>
      <p className="small">{body}</p>
      <p className="small muted">Tutorial years 1–5 use fixed news so the lessons land. Normal matches never do.</p>
    </aside>
  );
}

export function City() {
  const { s, me, act, open, prompt, why } = useGame();
  const here = s.players[me].district;
  const [sel, setSel] = useState<DistrictId>(here);
  const myTurn = prompt?.kind === 'turn';
  const shown = s.players[me].district === sel || DISTRICTS.includes(sel) ? sel : here;
  const canMove = myTurn && s.apRemaining > 0 && adjacent(s.content, here, shown);
  const companies = s.content.companies.filter((c) => c.district === shown);
  const props = s.content.properties.filter((p) => p.district === shown);
  const sectors = [...new Set(s.content.companies.map((c) => c.sector))].filter((sec) => researchDistricts(s.content, sec as Sector).includes(shown));

  return (
    <div className="stack">
      <Coach />
      <svg className="map" viewBox="0 0 440 320" aria-hidden="true">
        {s.content.edges.map(([a, b]) => <line key={a + b} className="edge" x1={POS[a][0]} y1={POS[a][1]} x2={POS[b][0]} y2={POS[b][1]} />)}
        {DISTRICTS.map((d) => (
          <g key={d} className={`node ${d === here ? 'here' : ''} ${myTurn && adjacent(s.content, here, d) ? 'reach' : ''} ${d === shown ? 'sel' : ''}`} onClick={() => setSel(d)}>
            <rect x={POS[d][0] - 62} y={POS[d][1] - 30} width="124" height="60" rx="14" />
            <text x={POS[d][0]} y={POS[d][1] - 4}>{DISTRICT_NAMES[d]}</text>
          </g>
        ))}
        {s.seatOrder.map((seat, i) => {
          const d = s.players[seat].district;
          const mates = s.seatOrder.filter((x) => s.players[x].district === d);
          const k = mates.indexOf(seat) - (mates.length - 1) / 2;
          return <circle key={seat} className="token" r={seat === me ? 9 : 7} cx="0" cy="0" style={{ transform: `translate(${POS[d][0] + k * 20}px, ${POS[d][1] + 14}px)` }} fill={s.players[seat].color} stroke="#fff" strokeWidth={seat === me ? 3 : 1.5} data-i={i} />;
        })}
      </svg>

      <section className="card stack" aria-live="polite">
        <div className="between">
          <h2>{DISTRICT_NAMES[shown]}</h2>
          {shown === here ? <span className="chip gold">You are here</span> : (
            <button className="primary" disabled={!canMove} onClick={() => void act({ type: 'Move', to: shown })}>
              {adjacent(s.content, here, shown) ? 'Move here · 1 AP' : 'Not adjacent'}
            </button>
          )}
        </div>
        <p className="muted small">{BLURB[shown]}</p>
        <div className="list">
          {shown === 'financial' ? (
            <>
              <button className="item" onClick={() => open({ kind: 'bank' })}><span className="t">The bank</span><span>Loans ›</span><span className="s">Borrow, refinance, see your credit ceiling and a stress test.</span></button>
              <button className="item" disabled={shown !== here || !!why('BuildRelationship') || s.players[me].relationshipRound === s.round} onClick={() => void act({ type: 'BuildRelationship' })}>
                <span className="t">Build relationships</span><span>1 AP</span><span className="s">+3 reputation (now {s.players[me].reputation}). Once a year. Better reputation, cheaper loans.</span>
              </button>
            </>
          ) : null}
          {shown === 'wallstreet' ? s.content.companies.filter((c) => c.kind === 'public').map((c) => (
            <button key={c.id} className="item" onClick={() => open({ kind: 'company', id: c.id })}><span className="t">{c.ticker} · {c.name}</span><span>Trade ›</span><span className="s">You hold {unitsOf(s, me, c.id).toLocaleString('en-US')} shares</span></button>
          )) : null}
          {companies.map((c) => (
            <button key={c.id} className="item" onClick={() => open({ kind: 'company', id: c.id })}>
              <span className="t">{c.name}</span><span>{c.kind === 'private' ? (unitsOf(s, 'bank', c.id) === c.sharesOutstanding ? `For sale ${usdShort(bankAskBusiness(s, c.id))}` : 'Private') : 'HQ'} ›</span>
              <span className="s">{c.kind === 'public' ? `${c.ticker} headquarters: owners with control set policy here.` : 'Private business. Buy, sell and manage it here.'}</span>
            </button>
          ))}
          {props.map((p) => (
            <button key={p.id} className="item" onClick={() => open({ kind: 'property', id: p.id })}>
              <span className="t">{p.name}</span><span>{s.ownership.titles[p.id] === 'bank' ? `For sale ${usdShort(bankAskProperty(s, p.id))}` : s.ownership.titles[p.id] === me ? 'Yours' : s.players[s.ownership.titles[p.id]]?.name} ›</span>
              <span className="s">Property title. Rent is paid to the owner once a year.</span>
            </button>
          ))}
          {sectors.map((sec) => {
            const done = s.players[me].research.find((r) => r.sector === sec && r.round === s.round);
            return (
              <button key={sec} className="item" disabled={shown !== here || !!why('Research') || (done?.confidence ?? 0) >= 75} onClick={() => void act({ type: 'Research', sector: sec as Sector })}>
                <span className="t">Research: {sec}</span><span>1 AP</span>
                <span className="s">{done ? `Private signal: demand ${done.low / 100}% to ${done.high / 100}% this year (${done.confidence}% confidence flavour, not a promise).` : 'A private, noisy read on this year\'s sector demand.'}</span>
              </button>
            );
          })}
        </div>
      </section>

      {myTurn ? (
        <div className="row">
          <button className={s.apRemaining === 0 ? 'primary grow' : 'grow'} onClick={() => void act({ type: 'EndTurn' })}>End turn{s.apRemaining > 0 ? ` (forfeit ${s.apRemaining} AP)` : ''}</button>
          <button onClick={() => open({ kind: 'help' })}>Rules</button>
        </div>
      ) : <button onClick={() => open({ kind: 'help' })}>Rules</button>}
      <nav aria-label="Districts">
        <h3 className="muted small" style={{ fontFamily: 'inherit', marginBottom: '0.4rem' }}>All districts</h3>
        <div className="district-list">
          {DISTRICTS.map((d) => {
            const who = s.seatOrder.filter((x) => s.players[x].district === d).map((x) => (x === me ? 'you' : s.players[x].name));
            return (
              <button key={d} aria-current={d === shown} onClick={() => setSel(d)}>
                <strong>{DISTRICT_NAMES[d]}</strong>{d === here ? ' ★' : adjacent(s.content, here, d) ? ' · 1 AP' : ''}
                <span className="small muted" style={{ display: 'block' }}>{who.length ? who.join(', ') : '—'}</span>
              </button>
            );
          })}
        </div>
      </nav>

    </div>
  );
}
