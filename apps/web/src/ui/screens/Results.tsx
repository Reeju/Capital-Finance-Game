import { Suspense, lazy, useState } from 'react';
import { REGIME_NAMES, assetName } from '@capital/engine';
import { exportSave } from '../../persistence/db';
import { usd, usdShort } from '../format';
import { useGame } from '../game';

const TrendChart = lazy(() => import('../Charts'));

function download(name: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function Results({ onExit }: { onExit: () => void }) {
  const { s, me, view } = useGame();
  const [note, setNote] = useState<string | null>(null);
  const res = s.result;
  if (!res) return null;
  const rounds = Array.from({ length: s.totalRounds }, (_, i) => i + 1);
  const data = rounds.map((r) => Object.fromEntries([['round', r], ...s.seatOrder.flatMap((seat) => { const h = s.players[seat].history[r - 1]; return h ? [[seat, h.netWorth], [`${seat}-debt`, h.debt]] : []; })]) as Record<string, number>);
  const news = s.log.filter((e) => e.type === 'news_open');
  const major = s.log.filter((e) => ['trade_executed', 'player_loan', 'rights_sold', 'auction_won', 'tender_filled', 'tender_failed', 'control_acquired', 'restructured', 'restart_grant'].includes(e.type));
  const winners = res.winners.map((w) => s.players[w].name);

  const shareCard = () => {
    // Public results only: no chat, no research, no private offers.
    const c = document.createElement('canvas');
    c.width = 1080;
    c.height = 1080;
    const x = c.getContext('2d');
    if (!x) return;
    x.fillStyle = '#0f1724';
    x.fillRect(0, 0, 1080, 1080);
    x.fillStyle = '#f2c14e';
    x.font = 'italic 44px Georgia';
    x.fillText(`Capital · ${s.totalRounds} years`, 70, 120);
    x.fillStyle = '#eef2f8';
    x.font = 'bold 84px Georgia';
    x.fillText(`${winners.join(' & ')} win${winners.length > 1 ? '' : 's'}`, 70, 240, 940);
    res.rows.forEach((r, i) => {
      const y = 380 + i * 150;
      x.fillStyle = s.players[r.seat].color;
      x.beginPath();
      x.arc(100, y - 18, 26, 0, Math.PI * 2);
      x.fill();
      x.fillStyle = '#eef2f8';
      x.font = 'bold 52px system-ui';
      x.fillText(`${r.rank}. ${s.players[r.seat].name}`, 150, y, 520);
      x.textAlign = 'right';
      x.fillText(usdShort(r.adjusted), 1010, y);
      x.textAlign = 'left';
      x.fillStyle = '#a9b6cc';
      x.font = '34px system-ui';
      x.fillText(r.label, 150, y + 48);
    });
    x.fillStyle = '#a9b6cc';
    x.font = '30px system-ui';
    x.fillText('A fictional game. No real money was harmed.', 70, 1020);
    c.toBlob((blob) => { if (blob) download('capital-result.png', blob); });
  };

  return (
    <div className="page stack">
      <header className="home-hero">
        <p className="tag">After {s.totalRounds} years</p>
        <h1>{winners.join(' & ')} {winners.length > 1 ? 'share the win' : 'wins'}</h1>
      </header>
      <section className="card">
        <h2>Final standings</h2>
        <table>
          <thead><tr><th scope="col">Player</th><th scope="col">Net worth</th><th scope="col">Rep. bonus</th><th scope="col">Grants</th><th scope="col">Score</th></tr></thead>
          <tbody>{res.rows.map((r) => (
            <tr key={r.seat}><td><span className="dot" style={{ background: s.players[r.seat].color }} /> {r.rank}. {s.players[r.seat].name}{r.seat === me ? ' (you)' : ''}<br /><span className="muted small">{r.label}</span></td><td>{usdShort(r.netWorth)}</td><td>+{usdShort(r.bonus)}</td><td>{r.grants ? `−${usdShort(r.grants)}` : '—'}</td><td><strong>{usdShort(r.adjusted)}</strong></td></tr>
          ))}</tbody>
        </table>
        <p className="small muted">Score = net worth + $100 per reputation point − restart grants. Ties go to higher net worth, then lower debt, then a shared win. Exact winning score: {usd(res.rows[0].adjusted)}.</p>
      </section>
      <section className="card stack">
        <h2>Net worth by year</h2>
        <Suspense fallback={<p className="muted">Loading chart…</p>}>
          <TrendChart label="Line chart of every player's net worth and debt by year. The same numbers are in the table below." data={data}
            series={s.seatOrder.flatMap((seat) => [{ key: seat, name: s.players[seat].name, color: s.players[seat].color }, { key: `${seat}-debt`, name: `${s.players[seat].name} debt`, color: s.players[seat].color, dashed: true }])} />
        </Suspense>
        <details><summary>Show as a table</summary>
          <table><thead><tr><th scope="col">Year</th>{s.seatOrder.map((x) => <th scope="col" key={x}>{s.players[x].name}</th>)}</tr></thead>
            <tbody>{rounds.map((r) => <tr key={r}><td>{r}</td>{s.seatOrder.map((x) => <td key={x}>{usdShort(s.players[x].history[r - 1]?.netWorth ?? 0)}</td>)}</tr>)}</tbody></table>
        </details>
      </section>
      <section className="card stack">
        <h2>Best and worst investments</h2>
        <p className="small muted">Gain = sale proceeds + income received + current value − what was paid. Positions still held are unrealized. Assets moved by player-to-player trades are not attributed here.</p>
        {res.rows.map((r) => (
          <p key={r.seat}><strong>{s.players[r.seat].name}:</strong> {r.best ? <>best {assetName(s, r.best.assetId)} {r.best.gain >= 0 ? '▲ +' : '▼ '}{usdShort(r.best.gain)} ({r.best.realized ? 'realized' : 'unrealized'})</> : 'made no investments'}{r.worst ? <>; worst {assetName(s, r.worst.assetId)} {r.worst.gain >= 0 ? '▲ +' : '▼ '}{usdShort(r.worst.gain)} ({r.worst.realized ? 'realized' : 'unrealized'})</> : null}</p>
        ))}
      </section>
      <section className="card"><h2>The economy</h2><ul className="feed">{news.map((e, i) => <li key={i}>{e.text.replace(`${REGIME_NAMES[s.macro.regime]}: `, '')}</li>)}</ul></section>
      <section className="card"><h2>Deals and drama</h2><ul className="feed">{major.length ? major.map((e, i) => <li key={i}><span className="muted">Y{e.round}</span> {e.text}</li>) : <li className="muted">A quiet table. Nobody signed anything.</li>}</ul></section>
      <details className="card"><summary>Full public replay ({s.log.length} events)</summary><ul className="feed">{s.log.map((e, i) => <li key={i}><span className="muted">Y{e.round}</span> {e.text}</li>)}</ul></details>
      <div className="row">
        <button className="primary grow" onClick={onExit}>Back to the menu</button>
        <button onClick={shareCard}>Save share card (PNG)</button>
        {view.mode !== 'online' ? <button onClick={() => void exportSave(s.matchId).then((text) => download(`capital-${s.matchId}.json`, new Blob([text], { type: 'application/json' }))).catch(() => setNote('Could not export this match.'))}>Export match</button> : null}
      </div>
      {note ? <p className="banner bad" role="alert">{note}</p> : null}
    </div>
  );
}
