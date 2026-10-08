// Regime transitions, the event deck and the Open-phase macro update.
import { type Ctx, emit } from './core';
import { clamp, divRound } from './money';
import { pickWeighted, randInt } from './rng';
import { MACRO_METRICS, REGIMES, SECTORS, type EventDef, type MacroMetric, type MatchState, type Regime, type Sector } from './types';

const pct = (bps: number) => `${(bps / 100).toFixed(1)}%`;
export const REGIME_NAMES: Record<Regime, string> = {
  recovery: 'Recovery', expansion: 'Expansion', boom: 'Boom', stagflation: 'Stagflation', recession: 'Recession', crisis: 'Crisis',
};

/** Transition weights for the next draw, after the forced-recovery rule, first-round rule and any event shift. */
export function transitionWeights(s: MatchState, forRound: number): number[] {
  const row = s.content.regimes[s.macro.regime].transitions;
  const w: Record<Regime, number> = { ...row };
  if (s.macro.crisisStreak >= 3) return REGIMES.map((r) => (r === 'recovery' ? 100 : 0));
  const shift = s.hidden.pendingShift;
  if (shift) {
    const moved = Math.min(shift.weight, 10, w[shift.from]);
    w[shift.from] -= moved;
    w[shift.to] += moved;
  }
  if (forRound === 1) {
    w.recovery += w.crisis;
    w.crisis = 0;
  }
  return REGIMES.map((r) => w[r]);
}

function eligible(s: MatchState, ev: EventDef, regime: Regime, forRound: number): boolean {
  if (ev.regimes.length > 0 && !ev.regimes.includes(regime)) return false;
  if (ev.notRegimes?.includes(regime)) return false;
  if (ev.requiresCompany && !s.companies[ev.requiresCompany]) return false;
  if (ev.requiresWarning) {
    const w = s.warnings[ev.requiresWarning];
    if (w === undefined || forRound - w > 3) return false;
  }
  if (ev.disaster && forRound <= 2) return false;
  const last = s.eventLastRound[ev.id];
  if (ev.id !== 'quiet_year' && last !== undefined && forRound - last <= 3) return false;
  return true;
}

/** Relative weights with the combined disaster mass capped at 5% of the draw. */
function cappedWeights(cands: EventDef[]): number[] {
  const scale = 1000;
  const normal = cands.reduce((a, e) => a + (e.disaster ? 0 : e.weight * scale), 0);
  const dis = cands.reduce((a, e) => a + (e.disaster ? e.weight * scale : 0), 0);
  const maxDis = Math.floor((normal * 5) / 95);
  return cands.map((e) => (e.disaster && dis > maxDis ? Math.floor((e.weight * scale * maxDis) / dis) : e.weight * scale));
}

/** Decide (but do not publish) the regime and events for `forRound`. Consumes macro/event stream draws. */
export function drawNews(ctx: Ctx, forRound: number): void {
  const s = ctx.s;
  const script = s.scenario === 'tutorial' ? s.content.tutorialScript[forRound - 1] : undefined;
  if (script) {
    s.hidden.pendingRegime = script.regime;
    s.hidden.pendingEvents = [...script.events];
    s.hidden.pendingShift = null;
    return;
  }
  const idx = pickWeighted(s.rng.macro, transitionWeights(s, forRound));
  const regime = REGIMES[idx < 0 ? 0 : idx];
  s.hidden.pendingRegime = regime;
  s.hidden.pendingShift = null;
  const picked: string[] = [];
  const macroCands = s.content.events.filter((e) => e.scope === 'macro' && eligible(s, e, regime, forRound));
  const mi = pickWeighted(s.rng.event, cappedWeights(macroCands));
  if (mi >= 0) picked.push(macroCands[mi].id);
  if (randInt(s.rng.event, 0, 1) === 1) {
    const other = s.content.events.filter((e) => e.scope !== 'macro' && eligible(s, e, regime, forRound));
    const oi = pickWeighted(s.rng.event, cappedWeights(other));
    if (oi >= 0) picked.push(other[oi].id);
  }
  s.hidden.pendingEvents = picked;
}

const BOUNDS: Record<MacroMetric, [number, number]> = {
  gdp: [-800, 600], inflation: [0, 1000], rate: [100, 1200], confidence: [0, 100], credit: [0, 100], commodity: [60, 180],
};

/** Publish the pending regime and events: smooth macro values toward targets, register modifiers, write the headline. */
export function applyOpenMacro(ctx: Ctx): void {
  const s = ctx.s;
  const m = s.macro;
  const regime = s.hidden.pendingRegime ?? m.regime;
  const target = s.content.regimes[regime];
  const events = s.hidden.pendingEvents.map((id) => s.content.events.find((e) => e.id === id)).filter((e): e is EventDef => !!e);
  const delta: Record<MacroMetric, number> = { gdp: 0, inflation: 0, rate: 0, confidence: 0, credit: 0, commodity: 0 };
  for (const ev of events) for (const mod of ev.modifiers) if (mod.target === 'macro' && (MACRO_METRICS as readonly string[]).includes(mod.metric)) delta[mod.metric as MacroMetric] += mod.delta;

  const why: string[] = [];
  const old = { ...m };
  const gdpResp = -divRound(old.rate - 400, 10);
  const rateResp = divRound(old.inflation - 250, 4);
  const step = (k: MacroMetric, adjustedOld: number, tgt: number) => clamp(divRound(adjustedOld + tgt, 2) + delta[k], BOUNDS[k][0], BOUNDS[k][1]);
  m.gdp = step('gdp', old.gdp + gdpResp, target.gdp);
  m.rate = step('rate', old.rate + rateResp, target.rate);
  m.inflation = step('inflation', old.inflation, target.inflation);
  m.confidence = step('confidence', old.confidence, target.confidence);
  m.credit = step('credit', old.credit, target.credit);
  m.commodity = clamp(old.commodity + divRound(100 - old.commodity, 4) + delta.commodity, BOUNDS.commodity[0], BOUNDS.commodity[1]);
  const shock = randInt(s.rng.macro, -500, 500);
  m.sentiment = clamp(divRound(old.sentiment + target.sentiment, 2) + shock, 5500, 14_500);
  const ev = (k: MacroMetric) => (delta[k] ? `, news ${delta[k] > 0 ? '+' : ''}${k === 'gdp' || k === 'inflation' || k === 'rate' ? pct(delta[k]) : delta[k]}` : '');
  const rn = REGIME_NAMES[regime];
  why.push(`GDP growth ${pct(old.gdp)} → ${pct(m.gdp)}: halfway to the ${rn} target ${pct(target.gdp)}, rate drag ${pct(gdpResp)}${ev('gdp')}.`);
  why.push(`Inflation ${pct(old.inflation)} → ${pct(m.inflation)}: halfway to target ${pct(target.inflation)}${ev('inflation')}.`);
  why.push(`Policy rate ${pct(old.rate)} → ${pct(m.rate)}: halfway to target ${pct(target.rate)}, inflation response ${pct(rateResp)}${ev('rate')}.`);
  why.push(`Confidence ${old.confidence} → ${m.confidence}; credit tightness ${old.credit} → ${m.credit}; commodities ${old.commodity} → ${m.commodity}.`);
  why.push(`Market mood ${(old.sentiment / 100).toFixed(0)} → ${(m.sentiment / 100).toFixed(0)}: halfway to ${(target.sentiment / 100).toFixed(0)} with a ${shock >= 0 ? '+' : ''}${(shock / 100).toFixed(1)} point wobble.`);
  m.explanations = why;
  m.crisisStreak = regime === 'crisis' ? (old.regime === 'crisis' ? old.crisisStreak + 1 : 1) : 0;
  m.regime = regime;

  // Sentiment mean-reverts 50% each Open, then takes this round's event offsets once.
  for (const sec of SECTORS) m.sectorSentiment[sec] = 10_000 + divRound(m.sectorSentiment[sec] - 10_000, 2);
  for (const co of Object.values(s.companies)) co.sentiment = 10_000 + divRound(co.sentiment - 10_000, 2);
  const headlines: string[] = [];
  for (const e of events) {
    headlines.push(e.headline);
    s.eventLastRound[e.id] = s.round;
    if (e.setsWarning) s.warnings[e.setsWarning] = s.round;
    if (e.transitionShift) s.hidden.pendingShift = e.transitionShift;
    for (const mod of e.modifiers) {
      if (mod.target === 'macro') continue;
      if (mod.metric === 'sentiment') {
        const d = clamp(mod.delta, -1000, 1000);
        const [kind, id] = mod.target.split(':');
        if (kind === 'sector' && (SECTORS as readonly string[]).includes(id)) m.sectorSentiment[id as Sector] = clamp(m.sectorSentiment[id as Sector] + d, 8500, 11_500);
        else if (kind === 'company' && s.companies[id]) s.companies[id].sentiment = clamp(s.companies[id].sentiment + d, 8000, 12_000);
      } else {
        s.modifiers.push({ eventId: e.id, target: mod.target, metric: mod.metric, delta: mod.delta, roundsLeft: mod.duration ?? e.duration });
      }
    }
    if (e.id !== 'quiet_year') emit(ctx, 'news_event', `${e.headline} — ${e.explanation}`, { data: { eventId: e.id } });
  }
  const quietOnly = events.every((e) => e.id === 'quiet_year');
  s.headline = quietOnly ? `${rn}: ${regimeBlurb(regime)}` : headlines.filter((h, i) => events[i].id !== 'quiet_year').join(' • ');
  emit(ctx, 'news_open', `Year ${s.round}: ${rn}. ${s.headline}`, { data: { regime } });
  s.hidden.pendingRegime = null;
  s.hidden.pendingEvents = [];
  for (const sec of SECTORS) s.hidden.sectorDemand[sec] = randInt(s.rng.event, -300, 300);
}

function regimeBlurb(r: Regime): string {
  switch (r) {
    case 'recovery': return 'A quiet year. Order books refill and nobody panics on television.';
    case 'expansion': return 'A quiet year. Everyone is hiring and pretending it was the plan.';
    case 'boom': return 'A quiet year, if you ignore the champagne.';
    case 'stagflation': return 'A quiet year. Prices rise, output does not, economists shrug.';
    case 'recession': return 'A quiet year, mostly because the phones stopped ringing.';
    case 'crisis': return 'No fresh news. The old news is quite enough.';
  }
}
