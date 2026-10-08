import type { Command, MatchState, SeatId } from '@capital/engine';
import type { RoomConfig, RoomPublic, SubmitResult } from '@capital/protocol';

export interface ChatLine { from: SeatId; text: string; at: number }
export interface View {
  /** Seat projection for `viewer`. UI derives everything from this; it never owns balances. */
  state: MatchState;
  viewer: SeatId;
  mode: 'solo' | 'local' | 'online';
  tutorial: boolean;
  coachDismissed: boolean;
  /** Pass-and-play: the seat that must confirm before its private view is shown. */
  curtain: SeatId | null;
  connection: 'ok' | 'reconnecting' | 'offline';
  /** Local-clock epoch ms when the prompted seat times out (online only). */
  deadline: number | null;
  room: RoomPublic | null;
  chat: ChatLine[];
  aiNote: string | null;
  readOnly: string | null;
  saveError: string | null;
}
export interface GameSession {
  getView(): View | null;
  subscribe(cb: () => void): () => void;
  submit(command: Command): Promise<SubmitResult>;
  confirmCurtain(): void;
  dismissCoach(): void;
  dispose(): void;
  online?: {
    ready(ready: boolean): void; start(): void; configure(config: RoomConfig): void; addAi(archetype: 'grace' | 'alex' | 'victor'): void;
    kick(seat: SeatId): void; chat(text: string): void; pauseVote(paused: boolean): void; lastError(): string | null;
  };
}
