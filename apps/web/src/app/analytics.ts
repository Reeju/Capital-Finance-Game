// Opt-in analytics provider. This build ships only a capped local queue: nothing is sent anywhere.
// Events carry no names, chat, research or holdings. A hosted provider can replace `sink` later.
import { db } from '../persistence/db';

export type AnalyticsEvent = 'match_start' | 'match_finish' | 'tutorial_step' | 'save_error' | 'online_join';
const CAP = 200;
let enabled = false;

export function setAnalyticsEnabled(on: boolean): void {
  enabled = on;
  if (!on) void db.kv.delete('analytics').catch(() => undefined); // revoking consent clears the queue
}

export function track(event: AnalyticsEvent, data: Record<string, string | number | boolean> = {}): void {
  if (!enabled) return;
  void db.transaction('rw', db.kv, async () => {
    const row = await db.kv.get('analytics');
    const queue = (Array.isArray(row?.value) ? row.value : []) as unknown[];
    queue.push({ event, at: Date.now(), ...data });
    await db.kv.put({ key: 'analytics', value: queue.slice(-CAP) });
  }).catch(() => undefined); // gameplay never depends on telemetry
}
