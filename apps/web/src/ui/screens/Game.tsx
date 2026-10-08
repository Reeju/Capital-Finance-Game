import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { type Command, type CommandType, REGIME_NAMES, currentPrompt, debtService, listLegalActions, liquidityWarning, valuePortfolio } from '@capital/engine';
import type { GameSession } from '../../session/types';
import { usdShort } from '../format';
import { type Game, type SheetSpec, GameContext } from '../game';
import { BankSheet } from '../sheets/BankSheet';
import { CompanySheet } from '../sheets/CompanySheet';
import { AccountsSheet, HelpSheet, NewsSheet, ReportSheet } from '../sheets/InfoSheets';
import { PropertySheet } from '../sheets/PropertySheet';
import { ListSheet, LoanOfferSheet, RightsSheet, TenderSheet, TradeSheet } from '../sheets/TradeSheets';
import { City } from './City';
import { Deals } from './Deals';
import { Market } from './Market';
import { Portfolio } from './Portfolio';
import { Results } from './Results';

type Tab = 'city' | 'portfolio' | 'market' | 'deals';

function Timer({ deadline }: { deadline: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, []);
  const left = Math.max(0, Math.ceil((deadline - now) / 1000));
  return <span className={`timer chip ${left <= 15 ? 'low' : ''}`} role="timer" aria-live={left === 15 ? 'assertive' : 'off'}>{left <= 15 ? '⚠ ' : '⏱ '}{Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')}</span>;
}

export function GameScreen({ session, onExit, sound }: { session: GameSession; onExit: () => void; sound: boolean }) {
  const view = useSyncExternalStore(session.subscribe, session.getView);
  const [tab, setTab] = useState<Tab>('city');
  const [sheet, setSheet] = useState<SheetSpec | null>(null);
  const [toast, setToast] = useState<{ text: string; info?: boolean } | null>(null);
  const seenRound = useRef<number | null>(null);
  const wasMyTurn = useRef(false);
  const lastKind = useRef<string | null>(null);
  const mainRef = useRef<HTMLElement>(null);
  useEffect(() => { mainRef.current?.scrollTo(0, 0); }, [tab]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4500);
    return () => clearTimeout(t);
  }, [toast]);

  const act = useCallback(async (command: Command) => {
    const r = await session.submit(command);
    if (!r.ok) setToast({ text: r.error?.message ?? 'That did not work.' });
    return r.ok;
  }, [session]);

  const round = view?.state.round ?? null;
  const viewer = view?.viewer;
  // Annual report: shown once when a new year opens for this viewer.
  useEffect(() => {
    if (round === null || view?.curtain) return;
    if (seenRound.current !== null && round > seenRound.current) setSheet({ kind: 'report' });
    seenRound.current = round;
  }, [round, viewer, view?.curtain]);

  const game = useMemo<Game | null>(() => {
    if (!view) return null;
    const s = view.state;
    const p = currentPrompt(s);
    const mine = p.kind !== 'none' && p.seat === view.viewer && !view.readOnly && !view.curtain ? p : null;
    const legal = listLegalActions({ seat: view.viewer, state: s });
    const can = (type: CommandType) => legal.find((a) => a.type === type);
    const why = (type: CommandType) => {
      if (view.readOnly) return view.readOnly;
      if (!mine) return 'Wait for your turn.';
      const a = can(type);
      if (!a) return mine.kind === 'turn' ? 'Not available.' : 'Not available right now.';
      return a.enabled ? null : a.reason ?? 'Not available.';
    };
    return { view, s, me: view.viewer, session, prompt: mine, act, open: setSheet, can, why };
  }, [view, session, act]);

  const myTurn = !!game?.prompt;
  useEffect(() => {
    if (myTurn && !wasMyTurn.current && sound) {
      try {
        const ctx = new AudioContext();
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.frequency.value = 660;
        g.gain.setValueAtTime(0.06, ctx.currentTime);
        g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.25);
        o.connect(g).connect(ctx.destination);
        o.start();
        o.stop(ctx.currentTime + 0.25);
        o.onended = () => void ctx.close();
      } catch { /* audio is optional */ }
    }
    wasMyTurn.current = myTurn;
    // Bring the right surface forward when what is asked of the player changes.
    const kind = game?.prompt?.kind ?? null;
    if (kind !== lastKind.current) {
      if (kind === 'turn') setTab('city');
      else if (kind) setTab('deals');
      lastKind.current = kind;
    }
  }, [myTurn, sound, game?.prompt?.kind]);

  if (!view || !game) return <div className="page"><p role="status">Loading the table…</p><button onClick={onExit}>Back</button></div>;
  const s = view.state;

  if (view.curtain) {
    return (
      <div className="curtain" role="dialog" aria-modal="true" aria-label="Pass the device">
        <div className="stack">
          <p className="muted">Pass the device</p>
          <h1><span className="dot" style={{ background: s.players[view.curtain].color }} /> {s.players[view.curtain].name}</h1>
          <p className="muted small">Nothing private is shown until you confirm. (This hides your view from the table, not from whoever owns the device.)</p>
          <button className="primary" onClick={() => session.confirmCurtain()}>I am {s.players[view.curtain].name}. Show my view</button>
        </div>
      </div>
    );
  }
  if (s.phase === 'finished') return <GameContext.Provider value={game}><Results onExit={onExit} /></GameContext.Provider>;

  const me = s.players[view.viewer];
  const v = valuePortfolio(s, view.viewer);
  const p = currentPrompt(s);
  const actor = p.kind !== 'none' ? s.players[p.seat] : null;
  const pending = Object.values(s.offers).filter((o) => o.status === 'open' && o.recipient === view.viewer).length;
  const warn = liquidityWarning(s, view.viewer);

  return (
    <GameContext.Provider value={game}>
      <div className="game">
        <header className="hud">
          <div className="between">
            <div className="row" style={{ gap: '0.4rem' }}>
              <button className="ghost" onClick={onExit} aria-label="Leave to the main menu">☰</button>
              <span className="chip gold">Year {s.round}/{s.totalRounds}</span>
              <button className="chip" style={{ minHeight: 0 }} onClick={() => setSheet({ kind: 'news' })} aria-label={`Economy: ${REGIME_NAMES[s.macro.regime]}. Open news`}>{REGIME_NAMES[s.macro.regime]} ›</button>
              {view.tutorial ? <span className="chip gold">Tutorial</span> : null}
              {view.connection !== 'ok' ? <span className="chip warn" role="status">⚠ {view.connection === 'offline' ? 'Offline' : 'Reconnecting'}</span> : null}
            </div>
            <div className="row" style={{ gap: '0.4rem' }}>
              {view.deadline && actor ? <Timer deadline={view.deadline} /> : null}
              {myTurn && p.kind === 'turn' ? (
                <span className="pips" role="img" aria-label={`${s.apRemaining} of 3 action points left`}>{[0, 1, 2].map((i) => <span key={i} className={`pip ${i < s.apRemaining ? 'on' : ''}`} />)}</span>
              ) : actor ? <span className="chip" role="status"><span className="dot" style={{ background: actor.color }} /> {actor.id === view.viewer ? 'You' : actor.name}{p.kind === 'turn' ? '' : p.kind === 'rescue' ? ' · rescue' : ' · deciding'}</span> : null}
            </div>
          </div>
          <p className="headline" title={s.headline}>{s.headline}</p>
        </header>

        <div className="cards4" role="group" aria-label="Your finances. Tap for the accounts.">
          {([['Net worth', v.netWorth], ['Cash', me.cash], ['Income / yr', me.lastIncome], ['Debt', v.liabilities]] as const).map(([k, val]) => (
            <button key={k} onClick={() => setSheet({ kind: 'accounts' })}>
              <span className="k">{k}{k === 'Debt' && warn ? ' ⚠' : ''}</span><span className="v num">{usdShort(val)}</span>
            </button>
          ))}
        </div>

        <main className="main" ref={mainRef}>
          {view.saveError ? <p className="banner bad" role="alert">{view.saveError}</p> : null}
          {view.readOnly ? <p className="banner" role="status">{view.readOnly}</p> : null}
          {warn ? <p className="banner" role="status">⚠ Liquidity warning: about {usdShort(debtService(s, view.viewer))} is due at this year's close and your cash looks thin. This is a warning, not a liquidation.</p> : null}
          {view.aiNote ? <p className="muted small" role="status">{view.aiNote}</p> : null}
          <div className="cols">
            <section className="pane pane-city" data-active={tab === 'city'} aria-label="City"><City /></section>
            <div>
              <section className="pane pane-market" data-active={tab === 'market'} data-hide={tab === 'deals'} aria-label="Market"><Market /></section>
              <section className="pane pane-deals" data-active={tab === 'deals'} aria-label="Deals"><Deals /></section>
            </div>
            <section className="pane pane-portfolio" data-active={tab === 'portfolio'} aria-label="Portfolio"><Portfolio /></section>
          </div>
        </main>

        <nav className="tabs" role="tablist" aria-label="Game sections">
          {([['city', 'City'], ['portfolio', 'Portfolio'], ['market', 'Market'], ['deals', 'Deals']] as const).map(([id, label]) => (
            <button key={id} role="tab" className={`tab-${id}`} aria-selected={tab === id} onClick={() => setTab(id)}>
              {label}{id === 'deals' && (pending > 0 || (myTurn && p.kind !== 'turn')) ? <span className="badge" aria-label="needs your answer">!</span> : null}
            </button>
          ))}
        </nav>
      </div>

      {sheet?.kind === 'company' ? <CompanySheet id={sheet.id} /> : null}
      {sheet?.kind === 'property' ? <PropertySheet id={sheet.id} /> : null}
      {sheet?.kind === 'bank' ? <BankSheet /> : null}
      {sheet?.kind === 'accounts' ? <AccountsSheet /> : null}
      {sheet?.kind === 'news' ? <NewsSheet /> : null}
      {sheet?.kind === 'report' ? <ReportSheet /> : null}
      {sheet?.kind === 'help' ? <HelpSheet onClose={() => setSheet(null)} /> : null}
      {sheet?.kind === 'trade' ? <TradeSheet /> : null}
      {sheet?.kind === 'loanOffer' ? <LoanOfferSheet /> : null}
      {sheet?.kind === 'rights' ? <RightsSheet /> : null}
      {sheet?.kind === 'tender' ? <TenderSheet id={sheet.id} /> : null}
      {sheet?.kind === 'list' ? <ListSheet /> : null}
      {toast ? <div className={`toast ${toast.info ? 'info' : ''}`} role="alert">{toast.text}</div> : null}
    </GameContext.Provider>
  );
}
