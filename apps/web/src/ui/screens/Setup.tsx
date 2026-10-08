import { useState } from 'react';
import { AI_BLURBS, AI_NAMES } from '@capital/ai';
import type { Archetype } from '@capital/engine';
import type { Settings } from '../../persistence/db';
import { newLocalMatch } from '../../session/local';
import { Seg } from '../kit';

export type SetupMode = 'solo' | 'local' | 'tutorial';
export const COLORS: [string, string][] = [['#e4572e', 'Vermilion'], ['#2e86ab', 'Blue'], ['#76b041', 'Green'], ['#a23b72', 'Plum']];
interface SeatDraft { name: string; kind: 'human' | 'ai'; archetype: Archetype }
const ARCHES: Archetype[] = ['grace', 'alex', 'victor'];

export function Setup({ mode, settings, onSettings, onBack, onStart }: { mode: SetupMode; settings: Settings; onSettings: (s: Settings) => void; onBack: () => void; onStart: (matchId: string) => void }) {
  const [name, setName] = useState(settings.name);
  const [color, setColor] = useState(settings.color);
  const [rounds, setRounds] = useState<12 | 20>(12);
  const [rivals, setRivals] = useState<Archetype[]>(['grace', 'alex']);
  const [seats, setSeats] = useState<SeatDraft[]>([{ name: settings.name || 'Player 1', kind: 'human', archetype: 'grace' }, { name: 'Player 2', kind: 'human', archetype: 'alex' }]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const others = COLORS.map(([c]) => c).filter((c) => c !== color);
      const list = mode === 'local'
        ? seats.map((s, i) => ({ name: s.kind === 'ai' ? AI_NAMES[s.archetype] : s.name.trim() || `Player ${i + 1}`, color: COLORS[i][0], kind: s.kind, archetype: s.kind === 'ai' ? s.archetype : undefined }))
        : [{ name: name.trim() || 'You', color, kind: 'human' as const }, ...(mode === 'tutorial' ? (['grace', 'alex'] as Archetype[]) : rivals).map((a, i) => ({ name: AI_NAMES[a], color: others[i], kind: 'ai' as const, archetype: a }))];
      if (mode !== 'local') onSettings({ ...settings, name: name.trim(), color });
      onStart(await newLocalMatch({ rounds: mode === 'tutorial' ? 12 : rounds, tutorial: mode === 'tutorial', seats: list }));
    } catch {
      setError('Could not create the match. Your browser may be blocking storage; try outside private browsing.');
      setBusy(false);
    }
  };

  return (
    <div className="page stack">
      <button onClick={onBack}>‹ Back</button>
      <h1>{mode === 'tutorial' ? 'Guided first game' : mode === 'solo' ? 'New solo game' : 'Pass and play'}</h1>
      {mode === 'tutorial' ? <p className="banner">A Quick game (12 years) against Grace and Alex. The first five years use fixed, labelled tutorial news; after that it is a normal match.</p> : null}

      {mode !== 'local' ? (
        <section className="card stack">
          <div className="field"><label htmlFor="name">Your name</label><input id="name" maxLength={24} value={name} onChange={(e) => setName(e.target.value)} placeholder="You" autoComplete="nickname" /></div>
          <div role="group" aria-label="Your colour" className="row">
            {COLORS.map(([c, label]) => <button key={c} aria-pressed={color === c} onClick={() => setColor(c)} style={{ borderColor: color === c ? '#fff' : undefined }}><span className="dot" style={{ background: c }} /> {label}</button>)}
          </div>
        </section>
      ) : null}

      {mode !== 'tutorial' ? (
        <section className="card stack">
          <div className="between"><h3>Length</h3><Seg label="Match length" value={rounds} onChange={setRounds} options={[[12, 'Quick · 12 years'], [20, 'Standard · 20 years']]} /></div>
          <p className="muted small">Quick runs roughly 20–30 minutes solo, Standard 35–60. Negotiation makes either longer. No turn timer offline.</p>
        </section>
      ) : null}

      {mode === 'solo' ? (
        <section className="card stack">
          <div className="between"><h3>Opponents</h3><Seg label="Number of opponents" value={rivals.length} onChange={(n) => setRivals(ARCHES.slice(0, n))} options={[[1, '1'], [2, '2'], [3, '3']]} /></div>
          {rivals.map((a, i) => (
            <div key={i} className="field">
              <label htmlFor={`rival-${i}`}>Opponent {i + 1}</label>
              <select id={`rival-${i}`} value={a} onChange={(e) => setRivals(rivals.map((x, j) => (j === i ? (e.target.value as Archetype) : x)))}>{ARCHES.map((x) => <option key={x} value={x}>{AI_NAMES[x]}: {AI_BLURBS[x]}</option>)}</select>
            </div>
          ))}
        </section>
      ) : null}

      {mode === 'local' ? (
        <section className="card stack">
          <div className="between"><h3>Seats</h3><Seg label="Number of seats" value={seats.length} onChange={(n) => setSeats(Array.from({ length: n }, (_, i) => seats[i] ?? { name: `Player ${i + 1}`, kind: 'human', archetype: ARCHES[i % 3] }))} options={[[2, '2'], [3, '3'], [4, '4']]} /></div>
          {seats.map((s, i) => (
            <div key={i} className="row">
              <span className="dot" style={{ background: COLORS[i][0] }} />
              <Seg label={`Seat ${i + 1} type`} value={s.kind} onChange={(kind) => setSeats(seats.map((x, j) => (j === i ? { ...x, kind } : x)))} options={[['human', 'Human'], ['ai', 'AI']]} />
              <div className="grow">
                {s.kind === 'human'
                  ? <><label htmlFor={`seat-${i}`} className="sr-only">Seat {i + 1} name</label><input id={`seat-${i}`} maxLength={24} value={s.name} onChange={(e) => setSeats(seats.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} /></>
                  : <><label htmlFor={`seat-ai-${i}`} className="sr-only">Seat {i + 1} AI</label><select id={`seat-ai-${i}`} value={s.archetype} onChange={(e) => setSeats(seats.map((x, j) => (j === i ? { ...x, archetype: e.target.value as Archetype } : x)))}>{ARCHES.map((x) => <option key={x} value={x}>{AI_NAMES[x]}</option>)}</select></>}
              </div>
            </div>
          ))}
          {seats.every((s) => s.kind === 'ai') ? <p className="small warn">Add at least one human seat.</p> : null}
          <p className="muted small">Between human turns a curtain hides private research and offers until the next player confirms. It is social privacy, not protection from the device's owner.</p>
        </section>
      ) : null}

      {error ? <p className="banner bad" role="alert">{error}</p> : null}
      <button className="primary" disabled={busy || (mode === 'local' && seats.every((s) => s.kind === 'ai'))} onClick={() => void start()}>{busy ? 'Dealing…' : 'Start with $500,000'}</button>
    </div>
  );
}
