// Shared state, content and command types for the Capital engine.
// Money is integer USD cents; Bps is integer basis points (10000 = 1.0 / 100%).
export type Money = number & { readonly __brand?: 'USD_cents' };
export type Bps = number & { readonly __brand?: 'basis_points' };
export type SeatId = string;
export type HolderId = SeatId | 'bank';

export const REGIMES = ['recovery', 'expansion', 'boom', 'stagflation', 'recession', 'crisis'] as const;
export type Regime = (typeof REGIMES)[number];
export const DISTRICTS = ['financial', 'wallstreet', 'industrial', 'tech', 'energy', 'realestate', 'downtown'] as const;
export type DistrictId = (typeof DISTRICTS)[number];
export const SECTORS = ['tech', 'utilities', 'consumer', 'industrial', 'logistics', 'health'] as const;
export type Sector = (typeof SECTORS)[number];
export type Archetype = 'grace' | 'alex' | 'victor';

// ---------- content ----------
export interface CompanyDef {
  id: string; ticker: string; name: string; kind: 'public' | 'private'; sector: Sector; district: DistrictId;
  revenue: Money; baseMargin: Bps; baseGrowth: Bps; baseMultiple: Bps;
  initialDebt: Money; initialCash: Money; risk: 1 | 2 | 3 | 4 | 5; sharesOutstanding: number; payout: Bps;
}
export interface PropertyDef {
  id: string; name: string; district: DistrictId; grossRent: Money; expense: Money; occupancy: Bps; capRate: Bps; upgradesMax: number;
}
export const MACRO_METRICS = ['gdp', 'inflation', 'rate', 'confidence', 'credit', 'commodity'] as const;
export type MacroMetric = (typeof MACRO_METRICS)[number];
export type AllowedMetric = MacroMetric | 'growth' | 'margin' | 'sentiment' | 'occupancy';
/** target: 'macro' | 'sector:<sector>' | 'company:<id>' | 'property:all'. Macro metrics apply once at Open. */
export interface EventModifier { target: string; metric: AllowedMetric; delta: number; duration?: number }
export interface EventDef {
  id: string; weight: number; scope: 'macro' | 'sector' | 'company'; regimes: Regime[]; notRegimes?: Regime[];
  requiresCompany?: string; requiresWarning?: string; setsWarning?: string; disaster?: boolean; duration: number;
  modifiers: EventModifier[]; transitionShift?: { from: Regime; to: Regime; weight: number };
  headline: string; explanation: string;
}
export interface SectorDef { gdpBeta: number; confBeta: number; commoditySens: number; rateSens: number }
export interface RegimeDef {
  gdp: Bps; inflation: Bps; rate: Bps; confidence: number; credit: number; sentiment: Bps; transitions: Record<Regime, number>;
}
export interface SynergyDef { propertyId: string; companyIds: string[]; marginBps: Bps }
export interface ContentPack {
  version: string;
  companies: CompanyDef[]; properties: PropertyDef[]; events: EventDef[];
  sectors: Record<Sector, SectorDef>; regimes: Record<Regime, RegimeDef>; synergies: SynergyDef[];
  edges: [DistrictId, DistrictId][];
  /** Optional scripted news for the labelled Tutorial scenario. */
  tutorialScript: { regime: Regime; events: string[] }[];
}

// ---------- state ----------
export interface MacroState {
  regime: Regime; gdp: Bps; inflation: Bps; rate: Bps; confidence: number; credit: number; commodity: number;
  sentiment: Bps; sectorSentiment: Record<Sector, Bps>; crisisStreak: number;
  /** Plain-language reasons for the most recent Open's moves. */
  explanations: string[];
}
export interface ActiveModifier { eventId: string; target: string; metric: AllowedMetric; delta: number; roundsLeft: number }
export interface CompanyState {
  id: string; revenue: Money; lastEBIT: Money; lastNet: Money; lastGrowth: Bps; lastMargin: Bps; lastDividend: Money;
  cash: Money; debt: Money; debtRate: Bps; debtMaturity: number | null; arrears: Money; payout: Bps;
  sentiment: Bps; boost: Bps; pendingBoost: Bps; policyRound: number;
}
export interface PropertyState { id: string; grossRent: Money; expense: Money; occupancy: Bps; upgrades: number; lastNOI: Money }
export interface ResearchSignal {
  id: string; sector: Sector; round: number; expiresRound: number; midpoint: Bps; low: Bps; high: Bps; confidence: number;
}
export interface HistoryPoint { round: number; netWorth: Money; debt: Money; income: Money; cash: Money }
/** Cash-flow record per asset, for end-of-game attribution. */
export interface Position { spent: Money; received: Money; income: Money }
export interface Player {
  id: SeatId; name: string; color: string; kind: 'human' | 'ai'; archetype?: Archetype;
  cash: Money; reputation: number; district: DistrictId; research: ResearchSignal[];
  grants: Money; minCash: Money; freezeUntil: number; proposalsThisRound: number; relationshipRound: number;
  repFromContracts: number; repContractRound: number; repCompanyRound: number; propertyArrears: Money;
  incomeThisRound: Money; lastIncome: Money; history: HistoryPoint[]; positions: Record<string, Position>; actionCounts: Record<string, number>;
}
export type Pledge = { kind: 'units'; companyId: string; units: number } | { kind: 'property'; propertyId: string };
export interface Loan {
  id: string; lender: 'bank' | SeatId; borrower: SeatId; principal: Money; rate: Bps; rateType: 'fixed' | 'floating'; spread: Bps;
  originatedRound: number; maturityRound: number; annualPrincipal: Money; accruedInterest: Money; arrears: Money;
  collateral: Pledge[]; status: 'current' | 'delinquent' | 'restructured' | 'paid'; restructuringId?: string;
}
export interface AssetBundle { cash: Money; units: Record<string, number>; properties: string[] }
export type OfferTerms =
  | { kind: 'trade' }
  | { kind: 'loan'; lender: SeatId; borrower: SeatId; principal: Money; rate: Bps; term: number; collateral: Pledge[] }
  | { kind: 'rights'; buyer: SeatId; seller: SeatId; companyId: string; bps: Bps; rounds: number; price: Money };
export interface TradeOffer {
  id: string; proposer: SeatId; recipient: SeatId; revision: number; give: AssetBundle; receive: AssetBundle; terms: OfferTerms;
  expiryRound: number; status: 'open' | 'accepted' | 'rejected' | 'withdrawn' | 'expired'; note?: string;
}
export interface Contract {
  id: string; kind: 'rights'; buyer: SeatId; seller: SeatId; companyId: string; bps: Bps; roundsLeft: number; units: number; trailing: Money;
}
export type AuctionAsset = { kind: 'property'; propertyId: string } | { kind: 'units'; companyId: string; units: number };
export interface Auction {
  id: string; asset: AuctionAsset; seller: HolderId; reserve: Money; highBid: Money; highBidder: SeatId | null;
  passed: SeatId[]; order: SeatId[]; next: number;
}
export interface Listing { seller: SeatId; asset: AuctionAsset; reserve: Money }
export interface Tender {
  id: string; bidder: SeatId; companyId: string; price: Money; maxShares: number; minShares: number; responses: Record<SeatId, number>;
}
export interface JournalLine { account: string; delta: Money }
export interface JournalEntry { id: number; round: number; revision: number; memo: string; lines: JournalLine[] }
export interface GameEvent {
  type: string; round: number; text: string; seat?: SeatId;
  /** If set, only these seats may see the event. */
  visibleTo?: SeatId[]; data?: Record<string, number | string | boolean | null>;
}
export interface RngStream { s: number; draws: number }
export interface HiddenState {
  pendingRegime: Regime | null; pendingEvents: string[]; pendingShift: { from: Regime; to: Regime; weight: number } | null;
  sectorDemand: Record<Sector, Bps>;
}
export interface SeatConfig { id: SeatId; name: string; color: string; kind: 'human' | 'ai'; archetype?: Archetype }
export interface MatchConfig { matchId: string; totalRounds: 12 | 20; seats: SeatConfig[]; scenario: 'normal' | 'tutorial' }
export interface ResultRow {
  seat: SeatId; netWorth: Money; grants: Money; bonus: Money; adjusted: Money; debt: Money; rank: number; label: string;
  best?: { assetId: string; gain: Money; realized: boolean }; worst?: { assetId: string; gain: Money; realized: boolean };
}
export interface Result { rows: ResultRow[]; winners: SeatId[] }
export type Phase = 'open' | 'turns' | 'deals' | 'earnings' | 'distress' | 'close' | 'finished';
export interface MatchState {
  schemaVersion: number; rulesVersion: string; contentVersion: string; matchId: string; scenario: 'normal' | 'tutorial';
  revision: number; round: number; totalRounds: 12 | 20; phase: Phase;
  seatOrder: SeatId[]; startIndex: number; turnIndex: number; activeSeat: SeatId; apRemaining: number;
  players: Record<SeatId, Player>; macro: MacroState; modifiers: ActiveModifier[];
  companies: Record<string, CompanyState>; properties: Record<string, PropertyState>;
  ownership: OwnershipLedger; control: Record<string, SeatId | null>;
  loans: Record<string, Loan>; offers: Record<string, TradeOffer>; contracts: Contract[];
  auction: Auction | null; listings: Listing[]; auctionCursor: number; tender: Tender | null;
  /** Net signed share flow against the bank this round, keyed `seat:companyId` (buys positive). */
  flow: Record<string, number>;
  distress: { queue: SeatId[]; decisionsLeft: number } | null;
  warnings: Record<string, number>; eventLastRound: Record<string, number>; headline: string;
  nextId: number; bankCash: Money; economyCash: Money;
  log: GameEvent[]; journal: JournalEntry[];
  rng: Record<string, RngStream>; hidden: HiddenState; result: Result | null;
  content: ContentPack;
}
export interface OwnershipLedger {
  /** companyId -> holder -> units. Every outstanding unit has exactly one holder (bank = free float). */
  units: Record<string, Record<HolderId, number>>;
  /** propertyId -> holder */
  titles: Record<string, HolderId>;
}

// ---------- commands ----------
export type Command =
  | { type: 'Move'; to: DistrictId }
  | { type: 'MarketOrder'; companyId: string; shares: number } // positive buys, negative sells
  | { type: 'Research'; sector: Sector }
  | { type: 'Borrow'; principal: Money; term: 3 | 5; rateType: 'fixed' | 'floating'; collateral: Pledge[] }
  | { type: 'Repay'; loanId: string; amount: Money }
  | { type: 'Refinance'; loanId: string; term: 3 | 5; rateType: 'fixed' | 'floating' }
  | { type: 'BuyAsset'; asset: { kind: 'business'; companyId: string } | { kind: 'property'; propertyId: string } }
  | { type: 'SellAsset'; asset: { kind: 'business'; companyId: string; units: number } | { kind: 'property'; propertyId: string } }
  | { type: 'SetPolicy'; companyId: string; payout: Bps }
  | { type: 'Reinvest'; companyId: string; amount: Money }
  | { type: 'CorpRepay'; companyId: string; amount: Money }
  | { type: 'CorpRefinance'; companyId: string }
  | { type: 'Upgrade'; propertyId: string }
  | { type: 'BuildRelationship' }
  | { type: 'ProposeTrade'; recipient: SeatId; give: AssetBundle; receive: AssetBundle; note?: string }
  | { type: 'ProposeLoan'; recipient: SeatId; role: 'lender' | 'borrower'; principal: Money; rate: Bps; term: number; collateral: Pledge[] }
  | { type: 'ProposeRights'; recipient: SeatId; role: 'buyer' | 'seller'; companyId: string; bps: Bps; rounds: number; price: Money }
  | { type: 'AcceptOffer'; offerId: string }
  | { type: 'RejectOffer'; offerId: string }
  | { type: 'WithdrawOffer'; offerId: string }
  | { type: 'ListAuction'; asset: AuctionAsset; reserve: Money }
  | { type: 'Bid'; amount: Money }
  | { type: 'PassAuction' }
  | { type: 'Tender'; companyId: string; price: Money; maxShares: number; minShares: number }
  | { type: 'TenderResponse'; shares: number }
  | { type: 'Restructure' }
  | { type: 'EndTurn' }
  | { type: 'TimeoutTurn' }; // system only: deadline expiry for the active seat
export type CommandType = Command['type'];
export interface CommandEnvelope {
  matchId: string; commandId: string; actorId: SeatId | 'system'; expectedRevision: number; rulesVersion: string; command: Command;
}
export interface ApplyResult { ok: boolean; state: MatchState; events: GameEvent[]; error?: { code: string; message: string } }
export type Prompt =
  | { kind: 'turn'; seat: SeatId }
  | { kind: 'offer'; seat: SeatId; offerId: string }
  | { kind: 'tender'; seat: SeatId }
  | { kind: 'auction'; seat: SeatId }
  | { kind: 'rescue'; seat: SeatId }
  | { kind: 'none' };
