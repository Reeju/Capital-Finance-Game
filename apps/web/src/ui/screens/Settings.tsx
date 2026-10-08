import { useEffect, useRef, useState } from 'react';
import { type SaveRow, type Settings, MAX_IMPORT_BYTES, deleteEverything, exportSave, importSave, listSaves } from '../../persistence/db';
import { Seg } from '../kit';

function Toggle({ label, hint, checked, onChange }: { label: string; hint: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="row" style={{ color: 'inherit', alignItems: 'start' }}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} style={{ width: '1.4rem', minHeight: '1.4rem', marginTop: '0.2rem' }} />
      <span className="grow"><strong>{label}</strong><br /><span className="muted small">{hint}</span></span>
    </label>
  );
}

export function SettingsScreen({ settings, onChange, onBack, onError }: { settings: Settings; onChange: (s: Settings) => void; onBack: () => void; onError: (m: string) => void }) {
  const [saves, setSaves] = useState<Pick<SaveRow, 'id' | 'meta' | 'finished'>[]>([]);
  const [note, setNote] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const refresh = () => void listSaves().then(setSaves).catch(() => setSaves([]));
  useEffect(refresh, []);

  const exportOne = async (id: string) => {
    try {
      const url = URL.createObjectURL(new Blob([await exportSave(id)], { type: 'application/json' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = `capital-${id}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch { onError('Could not export that match.'); }
  };
  const importFile = async (f: File | undefined) => {
    if (!f) return;
    if (f.size > MAX_IMPORT_BYTES) return setNote('That file is larger than the 10 MB import limit.');
    try {
      await importSave(await f.text());
      setNote('Imported. Find it under Saved matches on the home screen.');
      refresh();
    } catch (e) { setNote(e instanceof Error ? e.message : 'Import failed.'); }
  };

  return (
    <div className="page stack">
      <button onClick={onBack}>‹ Back</button>
      <h1>Settings</h1>
      <section className="card stack">
        <h2>Comfort</h2>
        <div className="between"><span><strong>Text size</strong></span><Seg label="Text size" value={settings.fontScale} onChange={(v) => onChange({ ...settings, fontScale: v })} options={[[100, 'Normal'], [115, 'Large'], [130, 'Larger']]} /></div>
        <Toggle label="High contrast" hint="Stronger borders and brighter text." checked={settings.highContrast} onChange={(v) => onChange({ ...settings, highContrast: v })} />
        <Toggle label="Reduce motion" hint="No token travel or sheet animation. Your system setting is respected too." checked={settings.reduceMotion} onChange={(v) => onChange({ ...settings, reduceMotion: v })} />
        <Toggle label="Sound" hint="A short tone when it becomes your turn." checked={settings.sound} onChange={(v) => onChange({ ...settings, sound: v })} />
      </section>
      <section className="card stack">
        <h2>Privacy</h2>
        <Toggle label="Share anonymous play statistics" hint="Off by default. This build has no analytics server: when on, a short anonymous event list is kept on this device only. Turning it off deletes that list. Names, chat, research and holdings are never recorded." checked={settings.analytics} onChange={(v) => onChange({ ...settings, analytics: v })} />
      </section>
      <section className="card stack">
        <h2>Saved matches</h2>
        <p className="muted small">Saves live in this browser. Export a match to back it up or move it. Imported files are checked and replayed through the rules before they are accepted. Local saves are editable by their owner and are not ranked.</p>
        {saves.map((s) => <div key={s.id} className="between"><span>{s.meta.label} <span className="muted small">{s.finished ? '· finished' : ''}</span></span><button onClick={() => void exportOne(s.id)}>Export</button></div>)}
        <div className="row">
          <button onClick={() => file.current?.click()}>Import a match…</button>
          <input ref={file} type="file" accept="application/json,.json" className="sr-only" aria-label="Import a saved match file" onChange={(e) => { void importFile(e.target.files?.[0]); e.target.value = ''; }} />
          <button className="danger" onClick={() => { if (window.confirm('Delete every saved match and setting on this device? This cannot be undone.')) void deleteEverything().then(() => { refresh(); setNote('All local data deleted.'); }); }}>Delete all local data</button>
        </div>
        {note ? <p className="banner" role="status">{note}</p> : null}
      </section>
      <section className="card stack">
        <h2>Install on your phone</h2>
        <p><strong>iPhone / iPad (Safari):</strong> tap Share, then “Add to Home Screen”.</p>
        <p><strong>Android (Chrome):</strong> open the ⋮ menu, then “Install app” or “Add to Home screen”.</p>
        <p className="muted small">Once installed and opened online once, solo and pass-and-play work offline. Online rooms always need a connection.</p>
      </section>
    </div>
  );
}
