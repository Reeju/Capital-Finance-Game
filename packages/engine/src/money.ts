// Integer money (USD cents) and basis-point arithmetic. No floats reach game state.
import type { Money } from './types';

export const MAX_SINGLE: Money = 10_000_000_000_00; // $10 billion in cents
export const MAX_TOTAL: Money = 100_000_000_000_00; // $100 billion in cents
export const BPS = 10_000;

export class RuleError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

export function reject(code: string, message: string): never {
  throw new RuleError(code, message);
}

/** round(a*b/d), half away from zero, exact for any safe-integer inputs. */
export function mulDiv(a: number, b: number, d: number): number {
  if (d === 0) throw new Error('mulDiv by zero');
  const p = a * b;
  if (Number.isSafeInteger(p)) return divRound(p, d);
  const n = BigInt(a) * BigInt(b);
  const dd = BigInt(d);
  const neg = n < 0n !== dd < 0n;
  const an = n < 0n ? -n : n;
  const ad = dd < 0n ? -dd : dd;
  const q = (an * 2n + ad) / (ad * 2n);
  return Number(neg ? -q : q);
}

/** round(n/d), half away from zero. */
export function divRound(n: number, d: number): number {
  const neg = n < 0 !== d < 0;
  const an = Math.abs(n);
  const ad = Math.abs(d);
  const q = Math.floor(an / ad);
  const r = an - q * ad;
  const out = r * 2 >= ad ? q + 1 : q;
  return neg ? -out : out;
}

/** floor(a*b/d) for non-negative inputs. */
export function mulDivFloor(a: number, b: number, d: number): number {
  const p = a * b;
  if (Number.isSafeInteger(p)) return Math.floor(p / d);
  return Number((BigInt(a) * BigInt(b)) / BigInt(d));
}

export function mulBps(value: Money, bps: number): Money {
  return mulDiv(value, bps, BPS);
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function assertMoney(v: unknown, what: string, allowZero = true): asserts v is Money {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0 || (!allowZero && v === 0)) {
    reject('bad_amount', `${what} must be a ${allowZero ? 'non-negative' : 'positive'} whole number of cents.`);
  }
  if (v > MAX_SINGLE) reject('limit', `${what} exceeds the $10 billion limit.`);
}

export function assertInt(v: unknown, what: string, lo: number, hi: number): asserts v is number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < lo || v > hi) {
    reject('bad_value', `${what} must be a whole number between ${lo} and ${hi}.`);
  }
}

/** Split `total` pro rata by integer weights, rounding down; residual cents go to the first key in `order`. */
export function distribute(total: number, weights: Record<string, number>, order: string[]): Record<string, number> {
  const sum = order.reduce((a, k) => a + (weights[k] ?? 0), 0);
  const out: Record<string, number> = {};
  if (sum <= 0 || total <= 0) return out;
  let paid = 0;
  for (const k of order) {
    const w = weights[k] ?? 0;
    if (w <= 0) continue;
    out[k] = mulDivFloor(total, w, sum);
    paid += out[k];
  }
  const first = order.find((k) => (weights[k] ?? 0) > 0);
  if (first !== undefined) out[first] += total - paid;
  return out;
}

export function fmtUsd(cents: Money): string {
  const neg = cents < 0;
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100);
  const c = abs % 100;
  const s = dollars.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${neg ? '-' : ''}$${s}${c ? '.' + String(c).padStart(2, '0') : ''}`;
}
