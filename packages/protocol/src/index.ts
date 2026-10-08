// Wire protocol shared by the web client and the authoritative server. Everything inbound is parsed here.
import { z } from 'zod';
import type { Command, CommandEnvelope, GameEvent, MatchState, SeatId } from '@capital/engine';

export const PROTOCOL_VERSION = 1;
export const MAX_PAYLOAD_BYTES = 16 * 1024;
export const CHAT_MAX = 300;

const money = z.number().int().min(0).max(10_000_000_000_00);
const id = z.string().min(1).max(32).regex(/^[A-Za-z0-9_-]+$/);
const district = z.enum(['financial', 'wallstreet', 'industrial', 'tech', 'energy', 'realestate', 'downtown']);
const sector = z.enum(['tech', 'utilities', 'consumer', 'industrial', 'logistics', 'health']);
const pledge = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('units'), companyId: id, units: z.number().int().min(1).max(1_000_000) }),
  z.strictObject({ kind: z.literal('property'), propertyId: id }),
]);
const bundle = z.strictObject({ cash: money, units: z.record(id, z.number().int().min(0).max(1_000_000)), properties: z.array(id).max(20) });
const auctionAsset = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('property'), propertyId: id }),
  z.strictObject({ kind: z.literal('units'), companyId: id, units: z.number().int().min(1).max(1_000_000) }),
]);
const term = z.union([z.literal(3), z.literal(5)]);
const rateType = z.enum(['fixed', 'floating']);
const pledges = z.array(pledge).max(20);

/** Commands a player client may send. TimeoutTurn is deliberately absent: only the server clock issues it. */
export const playerCommandSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('Move'), to: district }),
  z.strictObject({ type: z.literal('MarketOrder'), companyId: id, shares: z.number().int().min(-1_000_000).max(1_000_000) }),
  z.strictObject({ type: z.literal('Research'), sector }),
  z.strictObject({ type: z.literal('Borrow'), principal: money, term, rateType, collateral: pledges }),
  z.strictObject({ type: z.literal('Repay'), loanId: id, amount: money }),
  z.strictObject({ type: z.literal('Refinance'), loanId: id, term, rateType }),
  z.strictObject({ type: z.literal('BuyAsset'), asset: z.discriminatedUnion('kind', [z.strictObject({ kind: z.literal('business'), companyId: id }), z.strictObject({ kind: z.literal('property'), propertyId: id })]) }),
  z.strictObject({ type: z.literal('SellAsset'), asset: z.discriminatedUnion('kind', [z.strictObject({ kind: z.literal('business'), companyId: id, units: z.number().int().min(1).max(1_000_000) }), z.strictObject({ kind: z.literal('property'), propertyId: id })]) }),
  z.strictObject({ type: z.literal('SetPolicy'), companyId: id, payout: z.number().int().min(0).max(10_000) }),
  z.strictObject({ type: z.literal('Reinvest'), companyId: id, amount: money }),
  z.strictObject({ type: z.literal('CorpRepay'), companyId: id, amount: money }),
  z.strictObject({ type: z.literal('CorpRefinance'), companyId: id }),
  z.strictObject({ type: z.literal('Upgrade'), propertyId: id }),
  z.strictObject({ type: z.literal('BuildRelationship') }),
  z.strictObject({ type: z.literal('ProposeTrade'), recipient: id, give: bundle, receive: bundle, note: z.string().max(CHAT_MAX).optional() }),
  z.strictObject({ type: z.literal('ProposeLoan'), recipient: id, role: z.enum(['lender', 'borrower']), principal: money, rate: z.number().int().min(0).max(2000), term: z.number().int().min(1).max(5), collateral: pledges }),
  z.strictObject({ type: z.literal('ProposeRights'), recipient: id, role: z.enum(['buyer', 'seller']), companyId: id, bps: z.number().int().min(1).max(10_000), rounds: z.number().int().min(1).max(3), price: money }),
  z.strictObject({ type: z.literal('AcceptOffer'), offerId: id }),
  z.strictObject({ type: z.literal('RejectOffer'), offerId: id }),
  z.strictObject({ type: z.literal('WithdrawOffer'), offerId: id }),
  z.strictObject({ type: z.literal('ListAuction'), asset: auctionAsset, reserve: money }),
  z.strictObject({ type: z.literal('Bid'), amount: money }),
  z.strictObject({ type: z.literal('PassAuction') }),
  z.strictObject({ type: z.literal('Tender'), companyId: id, price: money, maxShares: z.number().int().min(1).max(1_000_000), minShares: z.number().int().min(1).max(1_000_000) }),
  z.strictObject({ type: z.literal('TenderResponse'), shares: z.number().int().min(0).max(1_000_000) }),
  z.strictObject({ type: z.literal('Restructure') }),
  z.strictObject({ type: z.literal('EndTurn') }),
]);

export const envelopeSchema = z.strictObject({
  matchId: id, commandId: z.string().min(8).max(64).regex(/^[A-Za-z0-9_-]+$/), actorId: id, expectedRevision: z.number().int().min(0),
  rulesVersion: z.string().min(1).max(40), command: playerCommandSchema,
});

export const roomConfigSchema = z.strictObject({
  totalRounds: z.union([z.literal(12), z.literal(20)]),
  maxSeats: z.number().int().min(2).max(4),
  pacing: z.enum(['standard', 'relaxed']),
  /** What happens to a seat that stays disconnected past its grace period. Agreed before the match starts. */
  disconnectPolicy: z.enum(['pass', 'ai']),
});
export type RoomConfig = z.infer<typeof roomConfigSchema>;
export const DEFAULT_ROOM_CONFIG: RoomConfig = { totalRounds: 12, maxSeats: 4, pacing: 'standard', disconnectPolicy: 'pass' };

export const clientMessageSchema = z.discriminatedUnion('t', [
  z.strictObject({ t: z.literal('hello'), protocolVersion: z.number().int(), lastSeenRevision: z.number().int().min(-1) }),
  z.strictObject({ t: z.literal('command'), envelope: envelopeSchema }),
  z.strictObject({ t: z.literal('requestSnapshot') }),
  z.strictObject({ t: z.literal('ready'), ready: z.boolean() }),
  z.strictObject({ t: z.literal('config'), config: roomConfigSchema }),
  z.strictObject({ t: z.literal('addAi'), archetype: z.enum(['grace', 'alex', 'victor']) }),
  z.strictObject({ t: z.literal('kick'), seatId: id }),
  z.strictObject({ t: z.literal('start') }),
  z.strictObject({ t: z.literal('chat'), text: z.string().min(1).max(CHAT_MAX) }),
  z.strictObject({ t: z.literal('pauseVote'), paused: z.boolean() }),
  z.strictObject({ t: z.literal('ping'), n: z.number().int() }),
]);
export type ClientMessage = z.infer<typeof clientMessageSchema>;

export interface RosterSeat { seatId: SeatId; name: string; color: string; kind: 'human' | 'ai'; ready: boolean; connected: boolean; host: boolean; aiControlled: boolean }
export interface RoomPublic {
  code: string; status: 'lobby' | 'playing' | 'finished'; config: RoomConfig; seats: RosterSeat[]; paused: boolean; pauseVotes: SeatId[];
  rulesVersion: string; contentVersion: string; deadline: number | null; serverTime: number;
}
/** Seat projection without the bulky immutable/append-only parts; the client keeps content and appends events itself. */
export type SlimState = Omit<MatchState, 'content' | 'log' | 'journal'>;
export interface Ack { commandId: string; accepted: boolean; revision: number; error?: { code: string; message: string } }
export type ServerMessage =
  | { t: 'welcome'; protocolVersion: number; seatId: SeatId; room: RoomPublic; snapshot: MatchState | null; revision: number; deadline: number | null; serverTime: number }
  | { t: 'room'; room: RoomPublic }
  | { t: 'ack'; ack: Ack }
  | { t: 'delta'; fromRevision: number; toRevision: number; events: GameEvent[]; state: SlimState; deadline: number | null; serverTime: number }
  | { t: 'snapshot'; snapshot: MatchState; revision: number; deadline: number | null; serverTime: number }
  | { t: 'chat'; from: SeatId; text: string; at: number }
  | { t: 'error'; code: string; message: string }
  | { t: 'pong'; n: number };

export function slim(state: MatchState): SlimState {
  const { content: _content, log: _log, journal: _journal, ...rest } = state;
  return rest;
}

/** What the transport promises the UI, local or online. */
export interface SubmitResult { ok: boolean; error?: { code: string; message: string } }
export type { Command, CommandEnvelope };

const ROOM_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no I, L, O, 0, 1
export function isRoomCode(code: string): boolean {
  return code.length === 8 && [...code.toUpperCase()].every((c) => ROOM_ALPHABET.includes(c));
}
export function roomCodeFromBytes(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < 8; i++) out += ROOM_ALPHABET[bytes[i] % ROOM_ALPHABET.length];
  return out;
}
export const createRoomSchema = z.strictObject({ name: z.string().trim().min(1).max(24), color: z.string().regex(/^#[0-9a-fA-F]{6}$/), config: roomConfigSchema });
export const joinRoomSchema = z.strictObject({ name: z.string().trim().min(1).max(24), color: z.string().regex(/^#[0-9a-fA-F]{6}$/) });
