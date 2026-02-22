import { Injectable, NotFoundException, ForbiddenException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { GameStatus, PointAward, Team } from '../shared/types';

export interface MoveResult {
  fen: string;
  san: string;
  from: string;
  to: string;
  promotion?: string;
  currentTurn: number; // 0-indexed move number
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
}

@Injectable()
export class GameService {
  constructor(private readonly prisma: PrismaService) {}

  async startGame(lobbyId: string): Promise<{ gameId: string; activeSeatIndex: number }> {
    const existing = await this.prisma.game.findUnique({ where: { lobbyId } });
    if (existing) throw new BadRequestException('Game already exists for this lobby');

    const game = await this.prisma.game.create({
      data: { lobbyId },
    });

    return { gameId: game.id, activeSeatIndex: 0 };
  }

  async getGameState(gameId: string) {
    const game = await this.prisma.game.findUnique({
      where: { id: gameId },
      include: {
        lobby: { include: { players: { orderBy: { seatIndex: 'asc' } } } },
        moves: { orderBy: { createdAt: 'asc' } },
        votes: true,
      },
    });
    if (!game) throw new NotFoundException('Game not found');
    return game;
  }

  async applyMove(gameId: string, playerId: string, from: string, to: string, san: string, fen: string, promotion?: string): Promise<MoveResult> {
    const game = await this.prisma.game.findUnique({
      where: { id: gameId },
      include: {
        moves: { orderBy: { createdAt: 'asc' } },
        lobby: { include: { players: { orderBy: { seatIndex: 'asc' } } } },
      },
    });
    if (!game) throw new NotFoundException('Game not found');
    if (game.status !== GameStatus.IN_PROGRESS) throw new BadRequestException('Game is not in progress');

    const moveIndex = game.moves.length;
    const activeSeatIndex = moveIndex % 4;
    const activePlayer = game.lobby.players.find(p => p.seatIndex === activeSeatIndex);

    if (!activePlayer || activePlayer.id !== playerId) {
      throw new ForbiddenException('Not your turn');
    }

    await this.prisma.move.create({
      data: { gameId, playerId, from, to, san, fen, promotion },
    });

    // Determine next active player
    const nextSeatIndex = (activeSeatIndex + 1) % 4;
    const nextPlayer = game.lobby.players.find(p => p.seatIndex === nextSeatIndex);

    return {
      fen,
      san,
      from,
      to,
      promotion,
      currentTurn: moveIndex + 1,
      activePlayerId: nextPlayer?.id ?? '',
      isGameOver: false,
      winner: null,
    };
  }

  async endGame(gameId: string, winner: Team): Promise<void> {
    await this.prisma.game.update({
      where: { id: gameId },
      data: { status: GameStatus.VOTING, winner },
    });
  }

  async castVote(gameId: string, voterId: string, suspectId: string): Promise<VoteResult> {
    const game = await this.prisma.game.findUnique({
      where: { id: gameId },
      include: {
        lobby: { include: { players: true } },
        votes: true,
      },
    });
    if (!game) throw new NotFoundException('Game not found');
    if (game.status !== GameStatus.VOTING) throw new BadRequestException('Game is not in voting phase');

    const alreadyVoted = game.votes.find(v => v.voterId === voterId);
    if (alreadyVoted) throw new BadRequestException('You already voted');

    await this.prisma.vote.create({ data: { gameId, voterId, suspectId } });

    const updatedVotes = await this.prisma.vote.findMany({ where: { gameId } });
    const totalPlayers = game.lobby.players.length;
    const isVotingComplete = updatedVotes.length >= totalPlayers;

    let eliminatedPlayerId: string | null = null;
    let wasImposterFound: boolean | null = null;

    if (isVotingComplete) {
      // Find the player with most votes
      const voteCounts = new Map<string, number>();
      for (const v of updatedVotes) {
        voteCounts.set(v.suspectId, (voteCounts.get(v.suspectId) ?? 0) + 1);
      }
      const maxVotes = Math.max(...voteCounts.values());
      const topSuspects = [...voteCounts.entries()].filter(([, count]) => count === maxVotes).map(([id]) => id);

      if (topSuspects.length === 1) {
        eliminatedPlayerId = topSuspects[0];
        const eliminated = game.lobby.players.find(p => p.id === eliminatedPlayerId);
        wasImposterFound = eliminated?.isImposter ?? false;
      }

      await this.prisma.game.update({
        where: { id: gameId },
        data: { status: GameStatus.FINISHED },
      });
    }

    return {
      votes: updatedVotes.map(v => ({ voterId: v.voterId, suspectId: v.suspectId })),
      totalPlayers,
      isVotingComplete,
      eliminatedPlayerId,
      wasImposterFound,
    };
  }

  async awardPoints(gameId: string): Promise<PointAward[]> {
    const game = await this.prisma.game.findUnique({
      where: { id: gameId },
      include: {
        lobby: { include: { players: true } },
        votes: true,
      },
    });
    if (!game) throw new NotFoundException('Game not found');

    const players = game.lobby.players;
    const imposter = players.find(p => p.isImposter);
    const correctVoteCount = imposter ? game.votes.filter(v => v.suspectId === imposter.id).length : 0;

    const awards: PointAward[] = [];

    for (const player of players) {
      let earned = 0;

      // +1 if non-imposter and their team won the chess game
      if (!player.isImposter && game.winner && player.team === game.winner) {
        earned += 1;
      }

      // +1 if they voted for the correct imposter
      if (imposter) {
        const theirVote = game.votes.find(v => v.voterId === player.id);
        if (theirVote && theirVote.suspectId === imposter.id) {
          earned += 1;
        }
      }

      // +3 if they were the imposter and ≤1 person correctly identified them
      if (player.isImposter && correctVoteCount <= 1) {
        earned += 3;
      }

      if (earned > 0) {
        await this.prisma.player.update({
          where: { id: player.id },
          data: { points: { increment: earned } },
        });
      }

      awards.push({ playerId: player.id, username: player.username, pointsEarned: earned });
    }

    return awards;
  }
}
