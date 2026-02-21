import { Injectable, NotFoundException, ForbiddenException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { LobbyDto, PlayerDto, LobbyStatus, Team, SEAT_TO_TEAM } from '../shared/types';

function generateCode(): string {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

function toPlayerDto(p: { id: string; username: string; team: string | null; seatIndex: number | null; isHost: boolean }): PlayerDto {
  return {
    id: p.id,
    username: p.username,
    team: p.team as Team | null,
    seatIndex: p.seatIndex,
    isHost: p.isHost,
  };
}

@Injectable()
export class LobbyService {
  constructor(private readonly prisma: PrismaService) {}

  async createLobby(username: string, socketId: string): Promise<{ lobby: LobbyDto; playerId: string }> {
    const code = generateCode();

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
    if (teamCount >= 2) throw new BadRequestException('Team is full (max 2 players)');

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

    // Assign seats: A1=0, B1=1, A2=2, B2=3
    const assignments = [
      { id: teamA[0].id, seatIndex: 0 },
      { id: teamB[0].id, seatIndex: 1 },
      { id: teamA[1].id, seatIndex: 2 },
      { id: teamB[1].id, seatIndex: 3 },
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
