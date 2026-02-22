export enum LobbyStatus {
  WAITING = 'WAITING',
  IN_PROGRESS = 'IN_PROGRESS',
  FINISHED = 'FINISHED',
}

export enum Team {
  A = 'A',
  B = 'B',
}

export interface PlayerDto {
  id: string;
  username: string;
  team: Team | null;
  seatIndex: number | null;
  isHost: boolean;
  isOnline: boolean;
  points: number;
}

export interface PointAward {
  playerId: string;
  username: string;
  pointsEarned: number;
}

export interface LobbyDto {
  id: string;
  code: string;
  hostId: string;
  status: LobbyStatus;
  players: PlayerDto[];
}

export interface MoveResult {
  fen: string;
  san: string;
  from: string;
  to: string;
  promotion?: string;
  currentTurn: number;
  activePlayerId: string;
  isGameOver: boolean;
  winner: Team | null;
}

export interface VoteResult {
  votes: { voterId: string; suspectId: string }[];
  totalPlayers: number;
  isVotingComplete: boolean;
  eliminatedPlayerId: string | null;
  wasImposterFound: boolean | null;
  imposterPlayerId: string | null;
}

export interface GameState {
  gameId: string;
  fen: string;
  moves: { from: string; to: string; san: string }[];
  activeSeatIndex: number;
  players: { id: string; username: string; team: Team; seatIndex: number }[];
}

export interface MyRole {
  isImposter: boolean;
  team: Team;
  seatIndex: number;
}
