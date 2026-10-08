import { useState } from 'react';
import {
  type AssetBundle, type AuctionAsset, type SeatId, availableUnits, defOf, describeBundle, minTenderPrice, propertyPledged, propertyValue, unitValue,
  unitsOf, valueCompany,
} from '@capital/engine';
import { pct, usd, usdShort } from '../format';
import { useGame } from '../game';
import { IntInput, KV, MoneyInput, Seg, Sheet } from '../kit';

function useOthers() {
  const { s, me } = useGame();
  return s.seatOrder.filter((x) => x !== me);
}

function Recipient({ value, onChange }: { value: SeatId; onChange: (v: SeatId) => void }) {
  const { s } = useGame();
  const others = useOthers();
  return (
    <div className="field">
      <label htmlFor="recipient">With</label>
      <select id="recipient" value={value} onChange={(e) => onChange(e.target.value)}>{others.map((x) => <option key={x} value={x}>{s.players[x].name}</option>)}</select>
    </div>
  );
}

function BundleEditor({ owner, value, onChange, title }: { owner: SeatId; value: AssetBundle; onChange: (b: AssetBundle) => void; title: string }) {
  const { s, me } = useGame();
  const companies = s.content.companies.filter((c) => unitsOf(s, owner, c.id) > 0);
  const props = s.content.properties.filter((p) => s.ownership.titles[p.id] === owner);
  return (
    <fieldset className="card" style={{ margin: 0 }}>
      <legend><strong>{title}</strong></legend>
      <MoneyInput id={`cash-${owner}`} label="Cash ($)" value={value.cash || null} onChange={(c) => onChange({ ...value, cash: c ?? 0 })} />
      {companies.map((c) => {
        const max = owner === me ? availableUnits(s, me, c.id) : unitsOf(s, owner, c.id);
        return <IntInput key={c.id} id={`u-${owner}-${c.id}`} label={`${c.kind === 'public' ? `${c.ticker} shares` : `${c.name} units (100 = 1%)`}`} max={max} value={value.units[c.id] ?? 0} onChange={(n) => onChange({ ...value, units: { ...value.units, [c.id]: Math.min(n, max) } })} />;
      })}
      {props.map((p) => (
        <label key={p.id} className="row" style={{ color: 'inherit' }}>
          <input type="checkbox" style={{ width: 'auto', minHeight: 0 }} checked={value.properties.includes(p.id)} onChange={(e) => onChange({ ...value, properties: e.target.checked ? [...value.properties, p.id] : value.properties.filter((x) => x !== p.id) })} />
          {p.name} ({usdShort(propertyValue(s, p.id))}){owner === me && propertyPledged(s, p.id) ? ' ⚠ pledged' : ''}
        </label>
      ))}
      {companies.length + props.length === 0 ? <p className="small muted">No assets, only cash.</p> : null}
    </fieldset>
  );
}

const empty = (): AssetBundle => ({ cash: 0, units: {}, properties: [] });
const worth = (s: Parameters<typeof unitValue>[0], b: AssetBundle) => b.cash + Object.entries(b.units).reduce((a, [id, n]) => a + unitValue(s, id, n), 0) + b.properties.reduce((a, id) => a + propertyValue(s, id), 0);

export function TradeSheet() {
  const { s, me, act, open, prompt } = useGame();
  const others = useOthers();
  const [to, setTo] = useState(others[0]);
  const [give, setGive] = useState(empty());
  const [receive, setReceive] = useState(empty());
  const [note, setNote] = useState('');
  const [review, setReview] = useState(false);
  const clean = (b: AssetBundle): AssetBundle => ({ ...b, units: Object.fromEntries(Object.entries(b.units).filter(([, n]) => n > 0)) });
  const g = clean(give);
  const r = clean(receive);
  const pledged = Object.keys(g.units).some((id) => availableUnits(s, me, id) < g.units[id]) || g.properties.some((id) => propertyPledged(s, id));
  return (
    <Sheet title="Propose a trade" description="Any price is legal, including gifts and lowballs. Once accepted, it is binding." onClose={() => open(null)}>
      <div className="stack">
        <Recipient value={to} onChange={(x) => { setTo(x); setReceive(empty()); }} />
        <BundleEditor owner={me} value={give} onChange={(b) => { setGive(b); setReview(false); }} title="You give" />
        <BundleEditor owner={to} value={receive} onChange={(b) => { setReceive(b); setReview(false); }} title={`You get from ${s.players[to].name}`} />
        <div className="field"><label htmlFor="note">Note (optional, not binding, 300 characters)</label><textarea id="note" maxLength={300} rows={2} value={note} onChange={(e) => setNote(e.target.value)} /></div>
        {pledged ? <p className="banner">⚠ Some of what you give is pledged to a lender. The deal only goes through if the cash you receive repays that loan in the same transaction.</p> : null}
        {review ? (
          <div className="banner" role="status">
            <p><span className="chip gold">Binding</span> You give <strong>{describeBundle(s, g)}</strong> (worth about {usdShort(worth(s, g))}) for <strong>{describeBundle(s, r)}</strong> (about {usdShort(worth(s, r))}).</p>
            <p className="small">What you offer is reserved until {s.players[to].name} answers in the deals window or the year ends. Liabilities never transfer with an asset.</p>
          </div>
        ) : null}
        <button className="primary" onClick={() => { if (!review) return setReview(true); void act({ type: 'ProposeTrade', recipient: to, give: g, receive: r, note: note.trim() || undefined }).then((ok) => { if (ok) open(null); }); }}>{review ? 'Send binding proposal' : `Review${prompt?.kind === 'turn' ? ' · 1 AP' : ''}`}</button>
      </div>
    </Sheet>
  );
}

export function LoanOfferSheet() {
  const { s, act, open } = useGame();
  const others = useOthers();
  const [to, setTo] = useState(others[0]);
  const [role, setRole] = useState<'lender' | 'borrower'>('lender');
  const [principal, setPrincipal] = useState<number | null>(50_000_00);
  const [rate, setRate] = useState(8);
  const [term, setTerm] = useState(3);
  const p = principal ?? 0;
  return (
    <Sheet title="Player loan" description="A binding contract the rules enforce. No bank guarantee: if they default, you may recover only part." onClose={() => open(null)}>
      <div className="stack">
        <Recipient value={to} onChange={setTo} />
        <Seg label="Your role" value={role} onChange={setRole} options={[['lender', 'I lend'], ['borrower', 'I borrow']]} />
        <MoneyInput id="lp" label="Principal ($)" value={principal} onChange={setPrincipal} />
        <div className="row">
          <div className="grow"><IntInput id="lr" label="Fixed rate % (0–20)" value={rate} onChange={(n) => setRate(Math.min(20, n))} /></div>
          <div className="grow"><IntInput id="lt" label="Years (1–5)" value={term} onChange={(n) => setTerm(Math.min(5, Math.max(1, n)))} /></div>
        </div>
        <KV rows={[['Yearly principal', usd(Math.ceil(p / Math.max(term, 1)))], ['First-year interest', usd(Math.round((p * rate) / 100))], ['Payments start', `at the close of year ${s.round + 1}`]]} />
        <button className="primary" disabled={!principal} onClick={() => void act({ type: 'ProposeLoan', recipient: to, role, principal: p, rate: rate * 100, term, collateral: [] }).then((ok) => { if (ok) open(null); })}>Send binding loan offer</button>
      </div>
    </Sheet>
  );
}

export function RightsSheet() {
  const { s, me, act, open } = useGame();
  const others = useOthers();
  const [to, setTo] = useState(others[0]);
  const [role, setRole] = useState<'buyer' | 'seller'>('seller');
  const seller = role === 'seller' ? me : to;
  const owned = s.content.companies.filter((c) => unitsOf(s, seller, c.id) > 0);
  const [companyId, setCompanyId] = useState('');
  const [share, setShare] = useState(50);
  const [rounds, setRounds] = useState(2);
  const [price, setPrice] = useState<number | null>(10_000_00);
  const cid = owned.some((c) => c.id === companyId) ? companyId : owned[0]?.id ?? '';
  const expected = cid ? Math.floor((Math.floor((s.companies[cid].lastDividend * unitsOf(s, seller, cid)) / defOf(s, cid).sharesOutstanding) * share) / 100) : 0;
  return (
    <Sheet title="Dividend rights" description="The buyer pays cash now for a share of the seller's actual dividends from one company. No dividend, no payment." onClose={() => open(null)}>
      <div className="stack">
        <Recipient value={to} onChange={setTo} />
        <Seg label="Your role" value={role} onChange={setRole} options={[['seller', 'I sell my dividends'], ['buyer', 'I buy theirs']]} />
        {owned.length === 0 ? <p className="banner">{seller === me ? 'You own' : `${s.players[seller].name} owns`} no company stake to sell dividends from.</p> : (
          <>
            <div className="field"><label htmlFor="rc">Company</label><select id="rc" value={cid} onChange={(e) => setCompanyId(e.target.value)}>{owned.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></div>
            <div className="row">
              <div className="grow"><IntInput id="rs" label="Share of dividends % (1–100)" value={share} onChange={(n) => setShare(Math.min(100, n))} /></div>
              <div className="grow"><IntInput id="rr" label="Years (1–3)" value={rounds} onChange={(n) => setRounds(Math.min(3, Math.max(1, n)))} /></div>
            </div>
            <MoneyInput id="rp" label="Price paid now ($)" value={price} onChange={setPrice} />
            <p className="small muted">At last year's dividend this would redirect about {usd(expected)} a year ({usd(expected * rounds)} in total). The seller's stake is locked against sale for the duration.</p>
            <button className="primary" disabled={!price || share < 1} onClick={() => { if (price) void act({ type: 'ProposeRights', recipient: to, role, companyId: cid, bps: share * 100, rounds, price }).then((ok) => { if (ok) open(null); }); }}>Send binding offer</button>
          </>
        )}
      </div>
    </Sheet>
  );
}

export function TenderSheet({ id }: { id: string }) {
  const { s, me, act, open, why } = useGame();
  const def = defOf(s, id);
  const mine = unitsOf(s, me, id);
  const need = Math.floor(def.sharesOutstanding / 2) + 1 - mine;
  const floor = minTenderPrice(s, id);
  const [price, setPrice] = useState<number | null>(floor);
  const [max, setMax] = useState(Math.max(need, 1));
  const [min, setMin] = useState(Math.max(need, 1));
  const escrow = (price ?? 0) * max;
  const block = why('Tender');
  return (
    <Sheet title={`Tender offer for ${def.ticker}`} description="A public bid for a block of shares. Holders choose whether to sell; nobody is forced." onClose={() => open(null)}>
      <div className="stack">
        <p className="small">You hold {mine.toLocaleString('en-US')}; control needs {need > 0 ? `${need.toLocaleString('en-US')} more` : 'no more'}. Market price {usd(valueCompany(s, id).mark)}. The free float tenders at your price; players decide in the deals window.</p>
        <MoneyInput id="tp" label={`Price per share ($, at least ${usd(floor)})`} value={price} onChange={setPrice} />
        <IntInput id="tmax" label="Buy at most" value={max} onChange={setMax} max={def.sharesOutstanding - mine} />
        <IntInput id="tmin" label="Only if at least this many are tendered" value={min} onChange={setMin} max={max} />
        <KV rows={[['Cash escrowed now', usd(escrow), true], ['If it fails', 'full refund, −5 reputation'], ['If over-subscribed', 'filled pro rata; unused escrow refunded']]} />
        {block ? <p className="small warn">{block}</p> : null}
        <button className="primary" disabled={!price || !!block || max < 1 || min < 1 || min > max} onClick={() => { if (price) void act({ type: 'Tender', companyId: id, price, maxShares: max, minShares: min }).then((ok) => { if (ok) open(null); }); }}>Launch tender · escrow {usdShort(escrow)} · 1 AP</button>
      </div>
    </Sheet>
  );
}

export function ListSheet() {
  const { s, me, act, open } = useGame();
  const assets: { key: string; label: string; asset: AuctionAsset; value: number }[] = [
    ...s.content.properties.filter((p) => s.ownership.titles[p.id] === me && !propertyPledged(s, p.id)).map((p) => ({ key: p.id, label: p.name, asset: { kind: 'property' as const, propertyId: p.id }, value: propertyValue(s, p.id) })),
    ...s.content.companies.filter((c) => availableUnits(s, me, c.id) > 0).map((c) => {
      const units = availableUnits(s, me, c.id);
      return { key: c.id, label: c.kind === 'public' ? `${units.toLocaleString('en-US')} ${c.ticker}` : `${pct(units, 0)} of ${c.name}`, asset: { kind: 'units' as const, companyId: c.id, units }, value: unitValue(s, c.id, units) };
    }),
  ];
  const [key, setKey] = useState(assets[0]?.key ?? '');
  const [reserve, setReserve] = useState<number | null>(null);
  const pick = assets.find((a) => a.key === key);
  return (
    <Sheet title="List an asset for auction" description="It replaces the bank's lot next year. Everyone else bids in turn; unsold if your reserve is not met." onClose={() => open(null)}>
      {assets.length === 0 ? <p className="banner">You have no unpledged, unreserved asset to list.</p> : (
        <div className="stack">
          <div className="field"><label htmlFor="la">Asset</label><select id="la" value={key} onChange={(e) => setKey(e.target.value)}>{assets.map((a) => <option key={a.key} value={a.key}>{a.label} (about {usdShort(a.value)})</option>)}</select></div>
          <MoneyInput id="lres" label="Reserve price ($, optional)" value={reserve} onChange={setReserve} />
          <button className="primary" disabled={!pick} onClick={() => { if (pick) void act({ type: 'ListAuction', asset: pick.asset, reserve: reserve ?? 0 }).then((ok) => { if (ok) open(null); }); }}>List for next year · 1 AP</button>
        </div>
      )}
    </Sheet>
  );
}
