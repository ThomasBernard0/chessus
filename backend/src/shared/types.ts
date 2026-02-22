// Shared types used across the application.
// Mirror the relevant ones in frontend/src/types/index.ts

export enum LobbyStatus {
  WAITING = 'WAITING',
  IN_PROGRESS = 'IN_PROGRESS',
  FINISHED = 'FINISHED',
}

export enum GameStatus {
  IN_PROGRESS = 'IN_PROGRESS',
  VOTING = 'VOTING',
  FINISHED = 'FINISHED',
}

export enum Team {
  A = 'A',
  B = 'B',
}

// seat 0 = A1, 1 = B1, 2 = A2, 3 = B2
// turn order: 0 → 1 → 2 → 3 → 0 …
// even turns → White (Team A); odd turns → Black (Team B)
export const SEAT_TO_TEAM: Record<number, Team> = {
  0: Team.A,
  1: Team.B,
  2: Team.A,
  3: Team.B,
};

export interface PlayerDto {
  id: string;
  username: string;
  team: Team | null;
  seatIndex: number | null;
  isHost: boolean;
  isOnline: boolean;
}

export interface LobbyDto {
  id: string;
  code: string;
  hostId: string;
  status: LobbyStatus;
  players: PlayerDto[];
}
