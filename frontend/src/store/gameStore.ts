import { create } from 'zustand';
import type { LobbyDto, GameState, MyRole, VoteResult } from '../types';

interface GameStore {
  // Identity
  playerId: string | null;
  username: string | null;

  // Lobby
  lobby: LobbyDto | null;

  // Game
  game: GameState | null;
  myRole: MyRole | null;
  voteResult: VoteResult | null;

  // Reconnect navigation
  pendingGameId: string | null;

  // Actions
  setIdentity: (playerId: string, username: string) => void;
  setLobby: (lobby: LobbyDto | null) => void;
  setGame: (game: GameState | null) => void;
  setMyRole: (role: MyRole) => void;
  updateFen: (fen: string, activeSeatIndex: number, moveCount: number) => void;
  setVoteResult: (result: VoteResult) => void;
  setPendingGameId: (gameId: string | null) => void;
  reset: () => void;
}

export const useGameStore = create<GameStore>((set) => ({
  playerId: null,
  username: null,
  lobby: null,
  game: null,
  myRole: null,
  voteResult: null,
  pendingGameId: null,

  setIdentity: (playerId, username) => set({ playerId, username }),
  setLobby: (lobby) => set({ lobby }),
  setGame: (game) => set({ game }),
  setMyRole: (myRole) => set({ myRole }),
  updateFen: (fen, activeSeatIndex, _currentTurn) =>
    set((state) => ({
      game: state.game ? { ...state.game, fen, activeSeatIndex } : null,
    })),
  setVoteResult: (voteResult) => set({ voteResult }),
  setPendingGameId: (pendingGameId) => set({ pendingGameId }),
  reset: () => set({ lobby: null, game: null, myRole: null, voteResult: null, pendingGameId: null }),
}));
