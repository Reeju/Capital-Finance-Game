import { useCallback, useEffect, useState } from 'react';
import type { Route } from '../../app/App';
import { type SaveRow, deleteSave, listSaves } from '../../persistence/db';

type SaveInfo = Pick<SaveRow, 'id' | 'revision' | 'updatedAt' | 'finished' | 'meta'>;

export function Home({ go, updateReady, onUpdate, onError }: { go: (r: Route) => void; updateReady: boolean; onUpdate: () => void; onError: (m: string) => void }) {
  const [saves, setSaves] = useState<SaveInfo[] | null>(null);
  const refresh = useCallback(() => void listSaves().then(setSaves).catch(() => { setSaves([]); onError('Saved games are unavailable on this device (storage is blocked). You can still play; progress will not be kept.'); }), [onError]);
  useEffect(refresh, [refresh]);
  const latest = saves?.find((s) => !s.finished);
  const first = saves !== null && saves.length === 0;

  return (
    <div className="page">
      <header className="home-hero">
        <h1>Capital</h1>
        <p className="tag">Buy low. Borrow carefully. Trust no one's handshake.</p>
      </header>
      {updateReady ? <p className="banner good" role="status">A new version is ready. <button className="link" onClick={onUpdate}>Update now</button> (saved matches keep the rules they started with.)</p> : null}
      <nav className="menu" aria-label="Main menu">
        {latest ? <button className="primary" onClick={() => go({ name: 'game', matchId: latest.id })}><strong>Continue</strong>{latest.meta.label}{latest.meta.tutorial ? ' · tutorial' : ''}</button> : null}
        <button className={latest ? undefined : 'primary'} onClick={() => go({ name: 'setup', mode: first ? 'tutorial' : 'solo' })}><strong>{first ? 'Play' : 'New solo game'}</strong>{first ? 'A guided quick game against Grace and Alex. About 20 minutes.' : 'You against one to three AI investors.'}</button>
        {first ? null : <button onClick={() => go({ name: 'setup', mode: 'tutorial' })}><strong>Guided tutorial</strong>Five scripted years that teach location, valuation and leverage.</button>}
        <button onClick={() => go({ name: 'setup', mode: 'local' })}><strong>Pass and play</strong>Two to four seats on one device, with a privacy curtain.</button>
        <button onClick={() => go({ name: 'online' })}><strong>Online room <span className="chip">beta</span></strong>Private rooms by invite code. Needs the game server.</button>
        <button onClick={() => go({ name: 'help' })}><strong>How to play</strong>The rules in two minutes.</button>
        <button onClick={() => go({ name: 'settings' })}><strong>Settings</strong>Text size, contrast, motion, saves, install help.</button>
      </nav>
      {saves && saves.length > 0 ? (
        <section className="stack" style={{ marginTop: '1.5rem' }}>
          <h2>Saved matches</h2>
          <div className="list">
            {saves.map((s) => (
              <div key={s.id} className="card between">
                <span><strong>{s.meta.label}</strong><br /><span className="muted small">{s.finished ? 'Finished' : 'In progress'} · {new Date(s.updatedAt).toLocaleString()}</span></span>
                <span className="row">
                  <button onClick={() => go({ name: 'game', matchId: s.id })}>{s.finished ? 'Results' : 'Resume'}</button>
                  <button className="danger" aria-label={`Delete ${s.meta.label}`} onClick={() => { if (window.confirm('Delete this saved match? This cannot be undone.')) void deleteSave(s.id).then(refresh); }}>Delete</button>
                </span>
              </div>
            ))}
          </div>
        </section>
      ) : null}
      <p className="muted small" style={{ marginTop: '2rem', textAlign: 'center' }}>A fictional, simplified game. No real money, securities or advice.</p>
    </div>
  );
}
