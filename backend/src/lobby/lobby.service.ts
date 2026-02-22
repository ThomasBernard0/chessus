import { Injectable, NotFoundException, ForbiddenException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { LobbyDto, PlayerDto, LobbyStatus, Team } from '../shared/types';

function generateCode(): string {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

function toPlayerDto(p: { id: string; username: string; socketId: string | null; team: string | null; seatIndex: number | null; isHost: boolean }): PlayerDto {
  return {
    id: p.id,
    username: p.username,
    team: p.team as Team | null,
    seatIndex: p.seatIndex,
    isHost: p.isHost,
    isOnline: p.socketId !== null,
  };
}

@Injectable()
export class LobbyService {
  constructor(private readonly prisma: PrismaService) {}

  async createLobby(username: string, socketId: string): Promise<{ lobby: LobbyDto; playerId: string }> {
    const code = generateCode();

    // Clear stale socketId from any existing player to avoid unique constraint violation
    await this.prisma.player.updateMany({ where: { socketId }, data: { socketId: null } });

    const player = await this.prisma.player.create({
      data: { username, socketId, isHost: true, team: Team.A, seatIndex: 0 },
    });

    const lobby = await this.prisma.lobby.create({
      data: {
        code,
        hostId: player.id,
        players: { connect: { id: player.id } },
      },
      include: { players: true },
    });

    return { lobby: this.toLobbyDto(lobby), playerId: player.id };
  }

  async joinLobby(code: string, username: string, socketId: string): Promise<{ lobby: LobbyDto; playerId: string }> {
    const lobby = await this.prisma.lobby.findUnique({
      where: { code },
      include: { players: true },
    });

    if (!lobby) throw new NotFoundException('Lobby not found');
    if (lobby.status !== LobbyStatus.WAITING) throw new BadRequestException('Lobby already started');
    if (lobby.players.length >= 4) throw new BadRequestException('Lobby is full');

    // Clear stale socketId from any existing player to avoid unique constraint violation
    await this.prisma.player.updateMany({ where: { socketId }, data: { socketId: null } });

    const player = await this.prisma.player.create({
      data: { username, socketId, lobbyId: lobby.id },
    });

    const updated = await this.prisma.lobby.findUnique({
      where: { id: lobby.id },
      include: { players: true },
    });

    return { lobby: this.toLobbyDto(updated!), playerId: player.id };
  }

  async leaveLobby(playerId: string): Promise<{ lobby: LobbyDto | null; newHostId: string | null }> {
    const player = await this.prisma.player.findUnique({
      where: { id: playerId },
      include: { lobby: { select: { status: true } } },
    });
    if (!player?.lobbyId) return { lobby: null, newHostId: null };

    // Don't remove a player once the game has started — deleting would violate FK
    // constraints from Move/Vote records and break the ongoing game.
    if (player.lobby?.status !== LobbyStatus.WAITING) return { lobby: null, newHostId: null };

    await this.prisma.player.delete({ where: { id: playerId } });

    const lobby = await this.prisma.lobby.findUnique({
      where: { id: player.lobbyId },
      include: { players: true },
    });

    if (!lobby || lobby.players.length === 0) {
      if (lobby) await this.prisma.lobby.delete({ where: { id: lobby.id } });
      return { lobby: null, newHostId: null };
    }

    let newHostId: string | null = null;
    if (player.isHost) {
      const newHost = lobby.players[0];
      await this.prisma.player.update({ where: { id: newHost.id }, data: { isHost: true } });
      await this.prisma.lobby.update({ where: { id: lobby.id }, data: { hostId: newHost.id } });
      newHostId = newHost.id;
    }

    const refreshed = await this.prisma.lobby.findUnique({
      where: { id: lobby.id },
      include: { players: true },
    });

    return { lobby: this.toLobbyDto(refreshed!), newHostId };
  }

  async changeTeam(playerId: string, team: Team): Promise<LobbyDto> {
    const player = await this.prisma.player.findUnique({ where: { id: playerId } });
    if (!player?.lobbyId) throw new NotFoundException('Player not in a lobby');

    const lobby = await this.prisma.lobby.findUnique({
      where: { id: player.lobbyId },
      include: { players: true },
    });
    if (!lobby) throw new NotFoundException('Lobby not found');

    const teamCount = lobby.players.filter(p => p.id !== playerId && p.team === team).length;
    if (teamCount >= 3) throw new BadRequestException('Team is full (max 3 players)');

    await this.prisma.player.update({ where: { id: playerId }, data: { team } });

    const updated = await this.prisma.lobby.findUnique({
      where: { id: lobby.id },
      include: { players: true },
    });

    return this.toLobbyDto(updated!);
  }

  async kickPlayer(hostPlayerId: string, targetPlayerId: string): Promise<LobbyDto> {
    const host = await this.prisma.player.findUnique({ where: { id: hostPlayerId } });
    if (!host?.isHost) throw new ForbiddenException('Only the host can kick players');

    const target = await this.prisma.player.findUnique({ where: { id: targetPlayerId } });
    if (!target || target.lobbyId !== host.lobbyId) throw new NotFoundException('Player not found in lobby');

    await this.prisma.player.delete({ where: { id: targetPlayerId } });

    const updated = await this.prisma.lobby.findUnique({
      where: { id: host.lobbyId! },
      include: { players: true },
    });

    return this.toLobbyDto(updated!);
  }

  async markPlayerOffline(playerId: string): Promise<{ lobby: LobbyDto | null; newHostId: string | null }> {
    const player = await this.prisma.player.findUnique({
      where: { id: playerId },
      include: { lobby: { select: { id: true, status: true } } },
    });
    if (!player?.lobbyId) return { lobby: null, newHostId: null };

    await this.prisma.player.update({
      where: { id: playerId },
      data: { socketId: null },
    });

    const lobby = await this.prisma.lobby.findUnique({
      where: { id: player.lobbyId },
      include: { players: true },
    });
    if (!lobby) return { lobby: null, newHostId: null };

    let newHostId: string | null = null;
    if (player.isHost && player.lobby?.status === LobbyStatus.WAITING) {
      const nextOnline = lobby.players.find(p => p.id !== playerId && p.socketId !== null);
      if (nextOnline) {
        await this.prisma.player.update({ where: { id: nextOnline.id }, data: { isHost: true } });
        await this.prisma.player.update({ where: { id: playerId }, data: { isHost: false } });
        await this.prisma.lobby.update({ where: { id: lobby.id }, data: { hostId: nextOnline.id } });
        newHostId = nextOnline.id;
        const refreshed = await this.prisma.lobby.findUnique({
          where: { id: lobby.id },
          include: { players: true },
        });
        return { lobby: this.toLobbyDto(refreshed!), newHostId };
      }
    }

    return { lobby: this.toLobbyDto(lobby), newHostId };
  }

  async reconnectPlayer(playerId: string, newSocketId: string): Promise<{
    player: {
      id: string;
      lobbyId: string | null;
      lobby: { id: string; code: string; status: string; gameId: string | null } | null;
    };
  } | null> {
    const player = await this.prisma.player.findUnique({
      where: { id: playerId },
      include: { lobby: true },
    });
    if (!player) return null;

    await this.prisma.player.update({
      where: { id: playerId },
      data: { socketId: newSocketId },
    });

    let gameId: string | null = null;
    if (player.lobbyId) {
      const game = await this.prisma.game.findFirst({
        where: { lobbyId: player.lobbyId },
        select: { id: true },
      });
      gameId = game?.id ?? null;
    }

    return {
      player: {
        id: player.id,
        lobbyId: player.lobbyId,
        lobby: player.lobby
          ? {
              id: player.lobby.id,
              code: player.lobby.code,
              status: player.lobby.status,
              gameId,
            }
          : null,
      },
    };
  }

  async resetAfterGame(lobbyId: string): Promise<LobbyDto | null> {
    const game = await this.prisma.game.findUnique({ where: { lobbyId } });
    if (game) {
      await this.prisma.vote.deleteMany({ where: { gameId: game.id } });
      await this.prisma.move.deleteMany({ where: { gameId: game.id } });
      await this.prisma.game.delete({ where: { id: game.id } });
    }

    await this.prisma.lobby.update({ where: { id: lobbyId }, data: { status: LobbyStatus.WAITING } });
    await this.prisma.player.updateMany({ where: { lobbyId }, data: { seatIndex: null, isImposter: false } });

    const refreshed = await this.prisma.lobby.findUnique({ where: { id: lobbyId }, include: { players: true } });
    return refreshed ? this.toLobbyDto(refreshed) : null;
  }

  async getLobbyById(lobbyId: string): Promise<LobbyDto | null> {
    const lobby = await this.prisma.lobby.findUnique({
      where: { id: lobbyId },
      include: { players: true },
    });
    return lobby ? this.toLobbyDto(lobby) : null;
  }

  async getPlayerLobbyId(playerId: string): Promise<string | null> {
    const player = await this.prisma.player.findUnique({
      where: { id: playerId },
      select: { lobbyId: true },
    });
    return player?.lobbyId ?? null;
  }

  async getLobby(code: string): Promise<LobbyDto | null> {
    const lobby = await this.prisma.lobby.findUnique({
      where: { code },
      include: { players: true },
    });
    return lobby ? this.toLobbyDto(lobby) : null;
  }

  async assignSeatsAndImposter(lobbyId: string): Promise<void> {
    const lobby = await this.prisma.lobby.findUnique({
      where: { id: lobbyId },
      include: { players: true },
    });
    if (!lobby || lobby.players.length !== 4) throw new BadRequestException('Need exactly 4 players to start');

    const teamA = lobby.players.filter(p => p.team === Team.A);
    const teamB = lobby.players.filter(p => p.team === Team.B);
    if (teamA.length !== 2 || teamB.length !== 2) throw new BadRequestException('Each team must have exactly 2 players');

    // Randomly assign which team plays White (even seats) vs Black (odd seats)
    const teamAIsWhite = Math.random() < 0.5;
    const whiteTeam = teamAIsWhite ? teamA : teamB;
    const blackTeam = teamAIsWhite ? teamB : teamA;

    const assignments = [
      { id: whiteTeam[0].id, seatIndex: 0 },
      { id: blackTeam[0].id, seatIndex: 1 },
      { id: whiteTeam[1].id, seatIndex: 2 },
      { id: blackTeam[1].id, seatIndex: 3 },
    ];

    // Pick one random imposter
    const imposterIndex = Math.floor(Math.random() * 4);
    const allPlayers = [...teamA, ...teamB];

    for (let i = 0; i < assignments.length; i++) {
      await this.prisma.player.update({
        where: { id: assignments[i].id },
        data: {
          seatIndex: assignments[i].seatIndex,
          isImposter: allPlayers.find(p => p.id === assignments[i].id)!.id === allPlayers[imposterIndex].id,
        },
      });
    }

    await this.prisma.lobby.update({
      where: { id: lobbyId },
      data: { status: LobbyStatus.IN_PROGRESS },
    });
  }

  private toLobbyDto(lobby: { id: string; code: string; hostId: string; status: string; players: any[] }): LobbyDto {
    return {
      id: lobby.id,
      code: lobby.code,
      hostId: lobby.hostId,
      status: lobby.status as LobbyStatus,
      players: lobby.players.map(toPlayerDto),
    };
  }
}
