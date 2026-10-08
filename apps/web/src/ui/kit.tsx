// Small shared UI pieces. Dialog focus trapping and dismissal come from Radix; everything else is native HTML.
import * as Dialog from '@radix-ui/react-dialog';
import { type ReactNode, useEffect, useState } from 'react';
import { dollarsToCents } from './format';

export function Sheet({ title, onClose, children, description }: { title: string; description?: string; onClose: () => void; children: ReactNode }) {
  return (
    <Dialog.Root open onOpenChange={(open) => { if (!open) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="overlay" />
        <Dialog.Content className="sheet" aria-describedby={undefined}>
          <div className="sheet-head">
            <div>
              <Dialog.Title asChild><h2>{title}</h2></Dialog.Title>
              {description ? <p className="muted small">{description}</p> : null}
            </div>
            <Dialog.Close asChild><button className="ghost" aria-label="Close">✕</button></Dialog.Close>
          </div>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function KV({ rows }: { rows: [string, ReactNode, boolean?][] }) {
  return (
    <dl className="kv">
      {rows.map(([k, v, total]) => (
        <div key={k} style={{ display: 'contents' }}>
          <dt className={total ? 'total' : undefined}>{k}</dt>
          <dd className={total ? 'total' : undefined}>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Dollar entry. Reports whole cents, or null while the text is not a valid amount. */
export function MoneyInput({ label, value, onChange, id }: { label: string; value: number | null; onChange: (cents: number | null) => void; id: string }) {
  const [text, setText] = useState(value === null ? '' : String(value / 100));
  useEffect(() => {
    if (value !== null && dollarsToCents(text) !== value) setText(String(value / 100));
  }, [value, text]);
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input id={id} inputMode="decimal" autoComplete="off" value={text} onChange={(e) => { setText(e.target.value); onChange(e.target.value.trim() === '' ? null : dollarsToCents(e.target.value)); }} />
    </div>
  );
}

export function IntInput({ label, value, onChange, id, max }: { label: string; value: number; onChange: (n: number) => void; id: string; max?: number }) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}{max !== undefined ? ` (max ${max.toLocaleString('en-US')})` : ''}</label>
      <input id={id} inputMode="numeric" autoComplete="off" value={value === 0 ? '' : String(value)} onChange={(e) => { const n = Math.floor(Number(e.target.value.replace(/[^\d]/g, ''))); onChange(Number.isFinite(n) ? n : 0); }} />
    </div>
  );
}

export function Seg<T extends string | number>({ value, options, onChange, label }: { value: T; options: [T, string][]; onChange: (v: T) => void; label: string }) {
  return (
    <div className="seg" role="group" aria-label={label}>
      {options.map(([v, text]) => <button key={String(v)} type="button" aria-pressed={v === value} onClick={() => onChange(v)}>{text}</button>)}
    </div>
  );
}

export function Risk({ level }: { level: number }) {
  const words = ['', 'Very low', 'Low', 'Medium', 'High', 'Very high'];
  return <span className="chip" title="Risk: how widely results can swing">{'●'.repeat(level)}{'○'.repeat(5 - level)} {words[level]} risk</span>;
}
