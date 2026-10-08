// Authored V1 content: fictional companies, private businesses, properties, events, regimes and the district graph.
import type { CompanyDef, ContentPack, EventDef, PropertyDef, Regime, RegimeDef, Sector, SectorDef } from '@capital/engine';
import { contentSchema } from './schema';

const usd = (dollars: number) => Math.round(dollars * 100);
// content-1.0.1 tuning: the first balance batch showed stock-only returns near 19%/yr and prices pinned at the $1,000 ceiling
// with the spec table's base growth. Base growth is scaled to 60% of the table (see docs/balance.md).
// content-1.0.2: CloudForge Studio's multiple is 7 (the spec allows 4-7 for private firms). At 5 it was a clear
// first-pick prize and gave the first seat a 15-20% wealth edge in mirror matches.
const GROWTH_TUNE = 0.6;
const pub = (id: string, ticker: string, name: string, sector: Sector, district: CompanyDef['district'], revenueK: number, marginPct: number, growthPct: number, debtK: number, multiple: number, risk: CompanyDef['risk'], payoutPct: number): CompanyDef => ({
  id, ticker, name, kind: 'public', sector, district, revenue: usd(revenueK * 1000), baseMargin: marginPct * 100, baseGrowth: Math.round(growthPct * 100 * GROWTH_TUNE),
  baseMultiple: multiple * 10_000, initialDebt: usd(debtK * 1000), initialCash: usd(20_000), risk, sharesOutstanding: 10_000, payout: payoutPct * 100,
});
const priv = (id: string, name: string, sector: Sector, district: CompanyDef['district'], revenueK: number, marginPct: number, growthPct: number, multiple: number, risk: CompanyDef['risk']): CompanyDef => ({
  id, ticker: id.toUpperCase().slice(0, 4), name, kind: 'private', sector, district, revenue: usd(revenueK * 1000), baseMargin: marginPct * 100,
  baseGrowth: Math.round(growthPct * 100 * GROWTH_TUNE), baseMultiple: multiple * 10_000, initialDebt: 0, initialCash: 0, risk, sharesOutstanding: 10_000, payout: 5000,
});

const companies: CompanyDef[] = [
  pub('byte', 'BYTE', 'ByteForge', 'tech', 'tech', 500, 22, 18, 40, 8, 4, 25),
  pub('mpwr', 'MPWR', 'MetroPower', 'utilities', 'energy', 400, 25, 3, 100, 7, 2, 65),
  pub('artl', 'ARTL', 'American Retail', 'consumer', 'downtown', 700, 12, 8, 80, 7, 3, 40),
  pub('nova', 'NOVA', 'Nova Motors', 'industrial', 'industrial', 650, 14, 11, 140, 8, 4, 20),
  pub('harb', 'HARB', 'Harbor Logistics', 'logistics', 'industrial', 500, 18, 7, 70, 7, 3, 40),
  pub('nshl', 'NSHL', 'Northstar Health', 'health', 'downtown', 450, 20, 6, 50, 8, 2, 50),
  priv('cloudforge', 'CloudForge Studio', 'tech', 'tech', 100, 30, 12, 7, 4),
  priv('dockside', 'Dockside Freight', 'logistics', 'industrial', 120, 22, 6, 5, 3),
  priv('sunline', 'Sunline Services', 'utilities', 'energy', 90, 28, 5, 5, 2),
  priv('coffee', 'Main Street Coffee', 'consumer', 'downtown', 100, 20, 8, 5, 3),
];

const prop = (id: string, name: string, district: PropertyDef['district'], rentK: number, expenseK: number, occPct: number, capPct: number): PropertyDef => ({
  id, name, district, grossRent: usd(rentK * 1000), expense: usd(expenseK * 1000), occupancy: occPct * 100, capRate: capPct * 100, upgradesMax: 2,
});
const properties: PropertyDef[] = [
  prop('offices', 'Prime Offices', 'realestate', 40, 10, 90, 8),
  prop('hotel', 'Grand Central Hotel', 'downtown', 45, 15, 80, 9),
  prop('warehouse', 'Harbor Warehouse', 'realestate', 30, 7, 95, 8),
  prop('apartments', 'Elm Apartments', 'realestate', 32, 8, 95, 7),
];

const sectors: Record<Sector, SectorDef> = {
  tech: { gdpBeta: 150, confBeta: 4, commoditySens: 0, rateSens: 14_000 },
  utilities: { gdpBeta: 30, confBeta: 0, commoditySens: -3, rateSens: 8000 },
  consumer: { gdpBeta: 120, confBeta: 6, commoditySens: -2, rateSens: 10_000 },
  industrial: { gdpBeta: 130, confBeta: 3, commoditySens: -4, rateSens: 11_000 },
  logistics: { gdpBeta: 100, confBeta: 3, commoditySens: -3, rateSens: 10_000 },
  health: { gdpBeta: 40, confBeta: 1, commoditySens: -1, rateSens: 7000 },
};

const reg = (gdp: number, inflation: number, rate: number, confidence: number, credit: number, sentiment: number, t: number[]): RegimeDef => ({
  gdp, inflation, rate, confidence, credit, sentiment,
  transitions: { recovery: t[0], expansion: t[1], boom: t[2], stagflation: t[3], recession: t[4], crisis: t[5] },
});
const regimes: Record<Regime, RegimeDef> = {
  recovery: reg(250, 200, 350, 55, 45, 10_500, [45, 40, 5, 3, 6, 1]),
  expansion: reg(350, 280, 450, 70, 25, 11_200, [10, 45, 25, 10, 8, 2]),
  boom: reg(400, 450, 600, 85, 20, 12_500, [5, 20, 35, 20, 15, 5]),
  stagflation: reg(-50, 600, 800, 35, 70, 8500, [15, 5, 5, 35, 30, 10]),
  recession: reg(-250, 150, 300, 30, 75, 8000, [35, 5, 0, 10, 40, 10]),
  crisis: reg(-500, 200, 200, 15, 95, 6500, [40, 0, 0, 5, 35, 20]),
};

const events: EventDef[] = [
  { id: 'cloud_wave', weight: 8, scope: 'sector', regimes: [], duration: 2, modifiers: [{ target: 'sector:tech', metric: 'growth', delta: 400 }, { target: 'sector:tech', metric: 'sentiment', delta: 500 }],
    headline: 'Cloud Investment Wave', explanation: 'Everyone is renting servers. Tech revenue growth +4% for two years; tech shares get a one-year mood lift.' },
  { id: 'confidence_surge', weight: 8, scope: 'macro', regimes: [], notRegimes: ['crisis'], duration: 1, modifiers: [{ target: 'macro', metric: 'confidence', delta: 10 }, { target: 'sector:consumer', metric: 'growth', delta: 200 }],
    headline: 'Consumer Confidence Surge', explanation: 'Shoppers feel rich. Confidence +10 now; consumer growth +2% this year.' },
  { id: 'inflation_surprise', weight: 7, scope: 'macro', regimes: ['expansion', 'boom'], duration: 1, setsWarning: 'inflation', modifiers: [{ target: 'macro', metric: 'inflation', delta: 150 }],
    headline: 'Inflation Surprise', explanation: 'Inflation +1.5% now. Warning: the central bank is clearing its throat. Rate risk is elevated, though nothing is certain.' },
  { id: 'rate_shock', weight: 5, scope: 'macro', regimes: [], duration: 1, requiresWarning: 'inflation', disaster: true, modifiers: [{ target: 'macro', metric: 'rate', delta: 250 }, { target: 'sector:tech', metric: 'sentiment', delta: -700 }],
    headline: 'Rate Shock', explanation: 'Policy rate +2.5% now. Long-dated growth stories (hello, tech) lose their shine for a year.' },
  { id: 'commodity_squeeze', weight: 6, scope: 'macro', regimes: [], duration: 1, modifiers: [{ target: 'macro', metric: 'commodity', delta: 20 }, { target: 'macro', metric: 'inflation', delta: 50 }],
    headline: 'Commodity Squeeze', explanation: 'Commodity index +20, inflation +0.5%. Margins shrink for anyone who buys fuel, steel or coffee beans.' },
  { id: 'nova_recall', weight: 5, scope: 'company', regimes: [], requiresCompany: 'nova', duration: 1, modifiers: [{ target: 'company:nova', metric: 'margin', delta: -500 }, { target: 'company:nova', metric: 'growth', delta: -500 }, { target: 'company:nova', metric: 'sentiment', delta: -800 }],
    headline: 'Nova Recall', explanation: 'Nova Motors recalls a model whose doors open "optimistically". Margin −5%, growth −5%, sentiment down for a year.' },
  { id: 'health_breakthrough', weight: 5, scope: 'company', regimes: [], requiresCompany: 'nshl', duration: 2, modifiers: [{ target: 'company:nshl', metric: 'growth', delta: 300 }, { target: 'company:nshl', metric: 'sentiment', delta: 500 }],
    headline: 'Healthcare Breakthrough', explanation: 'Northstar Health\'s new therapy works. Growth +3% for two years; a one-year sentiment lift.' },
  { id: 'credit_freeze', weight: 4, scope: 'macro', regimes: ['recession', 'crisis'], duration: 1, disaster: true, modifiers: [{ target: 'macro', metric: 'credit', delta: 15 }], transitionShift: { from: 'recovery', to: 'crisis', weight: 10 },
    headline: 'Credit Freeze', explanation: 'Banks stop returning calls. Credit tightness +15 now, and a crisis is a little more likely next year.' },
  { id: 'city_renewal', weight: 6, scope: 'macro', regimes: [], duration: 2, modifiers: [{ target: 'property:all', metric: 'occupancy', delta: 300 }],
    headline: 'City Renewal', explanation: 'New transit, cleaner streets. Property occupancy +3% for two years.' },
  { id: 'port_upgrade', weight: 5, scope: 'sector', regimes: [], duration: 2, modifiers: [{ target: 'sector:logistics', metric: 'growth', delta: 250 }],
    headline: 'Port Upgrade', explanation: 'Bigger cranes, faster ships. Logistics growth +2.5% for two years.' },
  { id: 'dividend_discipline', weight: 5, scope: 'sector', regimes: [], duration: 1, modifiers: [{ target: 'sector:utilities', metric: 'margin', delta: 100 }, { target: 'sector:utilities', metric: 'sentiment', delta: 200 }],
    headline: 'Dividend Discipline', explanation: 'Utilities trim costs to protect payouts. Utility margin +1% this year, with a small sentiment lift.' },
  { id: 'quiet_year', weight: 20, scope: 'macro', regimes: [], duration: 1, modifiers: [], headline: 'Quiet Year', explanation: 'Nothing in particular happened, which is news in itself.' },
];

export const content: ContentPack = {
  version: 'content-1.0.2',
  companies, properties, events, sectors, regimes,
  synergies: [{ propertyId: 'warehouse', companyIds: ['harb', 'dockside'], marginBps: 100 }],
  edges: [
    ['financial', 'wallstreet'], ['financial', 'industrial'], ['financial', 'realestate'], ['financial', 'downtown'], ['wallstreet', 'tech'],
    ['tech', 'industrial'], ['industrial', 'energy'], ['energy', 'realestate'], ['realestate', 'downtown'],
  ],
  // Tutorial only: growth, confidence, easy credit, inflation warning, rate shock.
  tutorialScript: [
    { regime: 'expansion', events: ['cloud_wave'] },
    { regime: 'expansion', events: ['confidence_surge'] },
    { regime: 'expansion', events: ['quiet_year'] },
    { regime: 'boom', events: ['inflation_surprise'] },
    { regime: 'stagflation', events: ['rate_shock'] },
  ],
};

/** Validate a content pack at an input boundary; throws with a readable message. */
export function validateContent(pack: unknown): ContentPack {
  return contentSchema.parse(pack) as ContentPack;
}

export { contentSchema };
