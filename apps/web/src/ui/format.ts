// Display formatting only. Accounting never touches these strings.
import type { Money } from '@capital/engine';

const exact = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2 });
const whole = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const compact = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 1 });

/** Exact dollars and cents, for confirmations. */
export const usd = (cents: Money): string => exact.format(cents / 100);
/** Rounded summary such as $500K, for cards and lists. */
export const usdShort = (cents: Money): string => (Math.abs(cents) >= 10_000_00 ? compact.format(cents / 100) : whole.format(cents / 100));
export const pct = (bps: number, digits = 1): string => `${(bps / 100).toFixed(digits)}%`;
export const signedPct = (bps: number, digits = 1): string => `${bps > 0 ? '+' : ''}${(bps / 100).toFixed(digits)}%`;
export const arrow = (n: number): string => (n > 0 ? '▲' : n < 0 ? '▼' : '■');
export const dollarsToCents = (text: string): number | null => {
  const n = Number(text.replace(/[$,\s]/g, ''));
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : null;
};
export const RISK_WORDS = ['', 'Very low', 'Low', 'Medium', 'High', 'Very high'];
