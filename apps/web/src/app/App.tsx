import { useCallback, useEffect, useRef, useState } from 'react';
import { registerSW } from 'virtual:pwa-register';
import { type Settings, DEFAULT_SETTINGS, loadSettings, saveSettings } from '../persistence/db';
import { LocalSession } from '../session/local';
import type { GameSession } from '../session/types';
import { GameScreen } from '../ui/screens/Game';
import { Home } from '../ui/screens/Home';
import { Online } from '../ui/screens/Online';
import { SettingsScreen } from '../ui/screens/Settings';
import { type SetupMode, Setup } from '../ui/screens/Setup';
import { Rules } from '../ui/rules';
import { setAnalyticsEnabled, track } from './analytics';

type Route = { name: 'home' } | { name: 'setup'; mode: SetupMode } | { name: 'game'; matchId: string } | { name: 'online'; code?: string } | { name: 'settings' } | { name: 'help' };

function initialRoute(): Route {
  const m = /^#\/room\/([A-Za-z0-9]{8})$/.exec(window.location.hash);
  return m ? { name: 'online', code: m[1].toUpperCase() } : { name: 'home' };
}

export function App() {
  const [route, setRoute] = useState<Route>(initialRoute);
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [session, setSession] = useState<GameSession | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [updateReady, setUpdateReady] = useState(false);
  const applyUpdate = useRef<(() => void) | null>(null);

  useEffect(() => {
    void loadSettings().then((s) => { setSettings(s); setAnalyticsEnabled(s.analytics); });
    // The service worker waits; a new build is applied only from Home, never mid-match.
    const update = registerSW({ onNeedRefresh: () => setUpdateReady(true) });
    applyUpdate.current = () => void update(true);
  }, []);

  useEffect(() => {
    const el = document.documentElement;
    el.style.setProperty('--scale', String(settings.fontScale / 100));
    el.dataset.contrast = settings.highContrast ? 'high' : 'normal';
    el.classList.toggle('reduce-motion', settings.reduceMotion);
  }, [settings]);

  const changeSettings = useCallback((s: Settings) => {
    setSettings(s);
    setAnalyticsEnabled(s.analytics);
    void saveSettings(s).catch(() => setError('Settings could not be saved on this device.'));
  }, []);

  const matchId = route.name === 'game' ? route.matchId : null;
  useEffect(() => {
    if (!matchId) return;
    let live: LocalSession | null = null;
    let cancelled = false;
    // ?aiDelay=0 lets automated tests skip the AI's thinking pause; it changes pacing only, never rules.
    const aiDelay = Number(new URLSearchParams(window.location.search).get('aiDelay') ?? 650);
    void LocalSession.open(matchId, Number.isFinite(aiDelay) ? Math.max(0, Math.min(aiDelay, 5000)) : 650).then((s) => {
      if (cancelled) return s.dispose();
      live = s;
      setSession(s);
    }).catch((e: unknown) => {
      track('save_error');
      setError(e instanceof Error ? e.message : 'Could not open that save.');
      setRoute({ name: 'home' });
    });
    return () => {
      cancelled = true;
      live?.dispose();
      setSession(null);
    };
  }, [matchId]);

  const home = () => {
    if (window.location.hash) history.replaceState(null, '', window.location.pathname);
    setRoute({ name: 'home' });
  };

  return (
    <>
      {error ? <div className="toast" role="alert" onClick={() => setError(null)}>{error} (tap to dismiss)</div> : null}
      {route.name === 'home' ? <Home go={setRoute} updateReady={updateReady} onUpdate={() => applyUpdate.current?.()} onError={setError} /> : null}
      {route.name === 'setup' ? <Setup mode={route.mode} settings={settings} onSettings={changeSettings} onBack={home} onStart={(id) => { track('match_start', { mode: route.mode }); setRoute({ name: 'game', matchId: id }); }} /> : null}
      {route.name === 'game' ? (session ? <GameScreen session={session} onExit={home} sound={settings.sound} /> : <div className="page"><p role="status">Opening your match…</p></div>) : null}
      {route.name === 'online' ? <Online code={route.code} settings={settings} onSettings={changeSettings} onBack={home} /> : null}
      {route.name === 'settings' ? <SettingsScreen settings={settings} onChange={changeSettings} onBack={home} onError={setError} /> : null}
      {route.name === 'help' ? <div className="page stack"><button onClick={home}>‹ Back</button><h1>How to play</h1><Rules /></div> : null}
    </>
  );
}
export type { Route };
