import { z } from 'zod';

const money = z.number().int().min(0).max(10_000_000_000_00);
const bps = z.number().int().min(-100_000).max(200_000);
const id = z.string().regex(/^[a-z0-9_]{1,24}$/);
const regime = z.enum(['recovery', 'expansion', 'boom', 'stagflation', 'recession', 'crisis']);
const district = z.enum(['financial', 'wallstreet', 'industrial', 'tech', 'energy', 'realestate', 'downtown']);
const sector = z.enum(['tech', 'utilities', 'consumer', 'industrial', 'logistics', 'health']);
const metric = z.enum(['gdp', 'inflation', 'rate', 'confidence', 'credit', 'commodity', 'growth', 'margin', 'sentiment', 'occupancy']);

const company = z.strictObject({
  id, ticker: z.string().min(1).max(5), name: z.string().min(1).max(40), kind: z.enum(['public', 'private']), sector, district,
  revenue: money, baseMargin: bps.min(300).max(4000), baseGrowth: bps.min(-3000).max(3000), baseMultiple: bps.min(30_000).max(140_000),
  initialDebt: money, initialCash: money, risk: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]),
  sharesOutstanding: z.number().int().min(100).max(1_000_000), payout: bps.min(0).max(10_000),
});
const property = z.strictObject({
  id, name: z.string().min(1).max(40), district, grossRent: money, expense: money, occupancy: bps.min(5000).max(9800),
  capRate: bps.min(500).max(1600), upgradesMax: z.number().int().min(0).max(5),
});
const modifier = z.strictObject({
  target: z.string().regex(/^(macro|all|sector:[a-z]+|company:[a-z0-9_]+|property:[a-z0-9_]+)$/), metric, delta: z.number().int().min(-5000).max(5000),
  duration: z.number().int().min(1).max(5).optional(),
});
const event = z.strictObject({
  id, weight: z.number().int().min(0).max(1000), scope: z.enum(['macro', 'sector', 'company']), regimes: z.array(regime), notRegimes: z.array(regime).optional(),
  requiresCompany: id.optional(), requiresWarning: id.optional(), setsWarning: id.optional(), disaster: z.boolean().optional(),
  duration: z.number().int().min(1).max(5), modifiers: z.array(modifier).max(8),
  transitionShift: z.strictObject({ from: regime, to: regime, weight: z.number().int().min(0).max(10) }).optional(),
  headline: z.string().min(1).max(80), explanation: z.string().min(1).max(300),
});
const sectorDef = z.strictObject({ gdpBeta: z.number().int(), confBeta: z.number().int(), commoditySens: z.number().int(), rateSens: z.number().int() });
const regimeDef = z.strictObject({
  gdp: bps, inflation: bps, rate: bps, confidence: z.number().int().min(0).max(100), credit: z.number().int().min(0).max(100), sentiment: bps,
  transitions: z.record(regime, z.number().int().min(0).max(100)),
}).refine((r) => Object.values(r.transitions).reduce((a, b) => a + (b ?? 0), 0) === 100, 'transition weights must sum to 100');

export const contentSchema = z.strictObject({
  version: z.string().min(1).max(40),
  companies: z.array(company).min(1).max(40), properties: z.array(property).max(40), events: z.array(event).min(1).max(100),
  sectors: z.record(sector, sectorDef), regimes: z.record(regime, regimeDef),
  synergies: z.array(z.strictObject({ propertyId: id, companyIds: z.array(id), marginBps: bps })),
  edges: z.array(z.tuple([district, district])),
  tutorialScript: z.array(z.strictObject({ regime, events: z.array(id) })),
}).superRefine((c, ctx) => {
  const ids = [...c.companies.map((x) => x.id), ...c.properties.map((x) => x.id)];
  if (new Set(ids).size !== ids.length) ctx.addIssue({ code: 'custom', message: 'asset ids must be unique' });
  const evIds = new Set(c.events.map((e) => e.id));
  if (evIds.size !== c.events.length) ctx.addIssue({ code: 'custom', message: 'event ids must be unique' });
  if (!evIds.has('quiet_year')) ctx.addIssue({ code: 'custom', message: 'a quiet_year macro event is required' });
  for (const t of c.tutorialScript) for (const e of t.events) if (!evIds.has(e)) ctx.addIssue({ code: 'custom', message: `tutorial references unknown event ${e}` });
  for (const e of c.events) if (e.requiresCompany && !c.companies.some((x) => x.id === e.requiresCompany)) ctx.addIssue({ code: 'custom', message: `event ${e.id} references unknown company` });
});
