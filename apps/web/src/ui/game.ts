import { createContext, useContext } from 'react';
import type { ActionDescriptor, Command, CommandType, MatchState, Prompt, SeatId } from '@capital/engine';
import type { GameSession, View } from '../session/types';

export type SheetSpec =
  | { kind: 'company'; id: string } | { kind: 'property'; id: string } | { kind: 'bank' } | { kind: 'accounts' } | { kind: 'news' } | { kind: 'report' }
  | { kind: 'trade' } | { kind: 'loanOffer' } | { kind: 'rights' } | { kind: 'tender'; id: string } | { kind: 'list' } | { kind: 'help' };

export interface Game {
  view: View; s: MatchState; me: SeatId; session: GameSession;
  /** The prompt, if it is this viewer's move. */
  prompt: Prompt | null;
  act: (command: Command) => Promise<boolean>;
  open: (sheet: SheetSpec | null) => void;
  can: (type: CommandType) => ActionDescriptor | undefined;
  /** Why an action is unavailable, or null when it can be attempted. */
  why: (type: CommandType) => string | null;
}

export const GameContext = createContext<Game | null>(null);
export function useGame(): Game {
  const g = useContext(GameContext);
  if (!g) throw new Error('useGame outside a match');
  return g;
}
