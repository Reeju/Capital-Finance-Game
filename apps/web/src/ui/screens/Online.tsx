import { useEffect, useState, useSyncExternalStore } from 'react';
import { AI_NAMES } from '@capital/ai';
import { type RoomConfig, DEFAULT_ROOM_CONFIG, isRoomCode } from '@capital/protocol';
import { track } from '../../app/analytics';
import type { Settings } from '../../persistence/db';
import { OnlineSession, createRoom, joinRoom, roomInfo, serverAvailable } from '../../session/online';
import { Seg } from '../kit';
import { GameScreen } from './Game';
import { COLORS } from './Setup';

function Lobby({ session, onLeave }: { session: OnlineSession; onLeave: () => void }) {
  useSyncExternalStore(session.subscribe, () => `${JSON.stringify(session.getRoom())}|${session.getConnection()}|${session.online.lastError()}`);
  const room = session.getRoom();
  const seat = session.getSeat();
  const [copied, setCopied] = useState(false);
  if (session.online.lastError() === 'kicked') return <div className="page stack"><p className="banner bad" role="alert">The host removed you from the room.</p><button onClick={onLeave}>Back</button></div>;
  if (!room) return <div className="page stack"><p role="status">Connecting to the room…</p><button onClick={onLeave}>Cancel</button></div>;
  const me = room.seats.find((s) => s.seatId === seat);
  const host = !!me?.host;
  const link = `${window.location.origin}${window.location.pathname}#/room/${room.code}`;
  const set = (patch: Partial<RoomConfig>) => session.online.configure({ ...room.config, ...patch });
  const canStart = room.seats.length >= 2 && room.seats.every((s) => s.host || s.ready);
  return (
    <div className="page stack">
      <button onClick={onLeave}>‹ Leave</button>
      <h1>Room {room.code}</h1>
      <p className="row"><span className={`chip ${session.getConnection() === 'ok' ? '' : 'warn'}`} role="status">{session.getConnection() === 'ok' ? '● Connected' : '⚠ Reconnecting…'}</span><span className="chip">Online beta</span></p>
      <section className="card stack">
        <h3>Invite</h3>
        <p className="small muted">Share the code or link. The code lets someone ask for a seat; it is not a password to anyone's seat.</p>
        <div className="row"><input readOnly value={link} aria-label="Invite link" className="grow" onFocus={(e) => e.target.select()} /><button onClick={() => void navigator.clipboard?.writeText(link).then(() => setCopied(true)).catch(() => setCopied(false))}>{copied ? 'Copied' : 'Copy link'}</button></div>
      </section>
      <section className="card stack">
        <h3>Seats ({room.seats.length}/{room.config.maxSeats})</h3>
        {room.seats.map((s) => (
          <div key={s.seatId} className="between">
            <span><span className="dot" style={{ background: s.color }} /> <strong>{s.name}</strong>{s.seatId === seat ? ' (you)' : ''} {s.host ? <span className="chip gold">Host</span> : null} {s.kind === 'ai' ? <span className="chip">AI</span> : null}</span>
            <span className="row"><span className="small">{s.kind === 'ai' ? 'Ready' : !s.connected ? '⚠ Disconnected' : s.host ? 'Host' : s.ready ? '✓ Ready' : 'Not ready'}</span>{host && s.seatId !== seat ? <button className="danger" onClick={() => session.online.kick(s.seatId)}>Remove</button> : null}</span>
          </div>
        ))}
        {host && room.seats.length < room.config.maxSeats ? <div className="row">{(['grace', 'alex', 'victor'] as const).map((a) => <button key={a} onClick={() => session.online.addAi(a)}>+ {AI_NAMES[a]} (AI)</button>)}</div> : null}
      </section>
      <section className="card stack">
        <h3>Rules for this room</h3>
        {host ? (
          <>
            <Seg label="Length" value={room.config.totalRounds} onChange={(v) => set({ totalRounds: v })} options={[[12, 'Quick · 12'], [20, 'Standard · 20']]} />
            <Seg label="Pacing" value={room.config.pacing} onChange={(v) => set({ pacing: v })} options={[['standard', '90 s turns'], ['relaxed', '5 min turns']]} />
            <Seg label="If a player stays disconnected" value={room.config.disconnectPolicy} onChange={(v) => set({ disconnectPolicy: v })} options={[['pass', 'Their turns pass'], ['ai', 'An AI covers for them']]} />
          </>
        ) : <p>{room.config.totalRounds} years · {room.config.pacing === 'relaxed' ? '5 minute' : '90 second'} turns, 30 second responses · disconnected seats {room.config.disconnectPolicy === 'ai' ? 'are covered by an AI until they return' : 'pass their turns'}.</p>}
        <p className="small muted">Settings lock when the match starts. Readying up means you accept them. A warning shows at 15 seconds; running out of time passes and never buys anything. A dropped player gets a 2-minute grace period (twice per match).</p>
      </section>
      {session.online.lastError() ? <p className="banner bad" role="alert">{session.online.lastError()}</p> : null}
      {host
        ? <button className="primary" disabled={!canStart} onClick={() => session.online.start()}>{canStart ? 'Start the match' : 'Waiting for everyone to be ready'}</button>
        : <button className="primary" onClick={() => session.online.ready(!me?.ready)}>{me?.ready ? 'Not ready after all' : 'I am ready'}</button>}
    </div>
  );
}

export function Online({ code, settings, onSettings, onBack }: { code?: string; settings: Settings; onSettings: (s: Settings) => void; onBack: () => void }) {
  const [available, setAvailable] = useState<boolean | null>(null);
  const [name, setName] = useState(settings.name);
  const [color, setColor] = useState(settings.color);
  const [joinCode, setJoinCode] = useState(code ?? '');
  const [config, setConfig] = useState<RoomConfig>(DEFAULT_ROOM_CONFIG);
  const [session, setSession] = useState<OnlineSession | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const started = useSyncExternalStore(session?.subscribe ?? (() => () => undefined), () => !!session?.getView());

  useEffect(() => {
    let cancelled = false;
    void serverAvailable().then(async (ok) => {
      if (cancelled) return;
      setAvailable(ok);
      // Returning to a room we already hold a seat in (cookie): reconnect without asking again.
      if (ok && code && (await roomInfo(code))?.mySeat && !cancelled) setSession(new OnlineSession(code));
    });
    return () => { cancelled = true; };
  }, [code]);
  useEffect(() => () => session?.dispose(), [session]);

  const enter = async (make: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const nick = name.trim() || 'Player';
      onSettings({ ...settings, name: name.trim(), color });
      const room = make ? await createRoom(nick, color, config) : joinCode.toUpperCase();
      if (!make) await joinRoom(room, nick, color);
      history.replaceState(null, '', `#/room/${room}`);
      track('online_join');
      setSession(new OnlineSession(room));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not reach the room.');
    } finally {
      setBusy(false);
    }
  };

  if (session && started) return <GameScreen session={session} onExit={onBack} sound={settings.sound} />;
  if (session) return <Lobby session={session} onLeave={onBack} />;
  return (
    <div className="page stack">
      <button onClick={onBack}>‹ Back</button>
      <h1>Online room <span className="chip">beta</span></h1>
      {available === null ? <p role="status">Looking for the game server…</p> : null}
      {available === false ? (
        <div className="banner" role="status">
          <p><strong>Online play is unavailable on this build.</strong> No game server answered at this address. Solo and pass-and-play work fully offline.</p>
          <p className="small">Running it yourself: start the server with <code>pnpm dev:server</code>, then reload. See docs/hosting.md.</p>
        </div>
      ) : null}
      {available ? (
        <>
          <section className="card stack">
            <div className="field"><label htmlFor="oname">Your name</label><input id="oname" maxLength={24} value={name} onChange={(e) => setName(e.target.value)} autoComplete="nickname" /></div>
            <div role="group" aria-label="Your colour" className="row">{COLORS.map(([c, label]) => <button key={c} aria-pressed={color === c} onClick={() => setColor(c)} style={{ borderColor: color === c ? '#fff' : undefined }}><span className="dot" style={{ background: c }} /> {label}</button>)}</div>
          </section>
          <section className="card stack">
            <h3>Join a room</h3>
            <div className="field"><label htmlFor="code">Invite code (8 characters)</label><input id="code" value={joinCode} maxLength={8} autoCapitalize="characters" autoComplete="off" onChange={(e) => setJoinCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))} /></div>
            <button className="primary" disabled={busy || !isRoomCode(joinCode)} onClick={() => void enter(false)}>Join</button>
          </section>
          <section className="card stack">
            <h3>Create a private room</h3>
            <Seg label="Seats" value={config.maxSeats} onChange={(v) => setConfig({ ...config, maxSeats: v })} options={[[2, '2 seats'], [3, '3'], [4, '4']]} />
            <button disabled={busy} onClick={() => void enter(true)}>Create room</button>
            <p className="small muted">Rooms are private and unlisted. No account needed: your seat is held by a cookie on this device. Chat and table talk are never binding.</p>
          </section>
        </>
      ) : null}
      {error ? <p className="banner bad" role="alert">{error}</p> : null}
    </div>
  );
}
