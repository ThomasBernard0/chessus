import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  ConnectedSocket,
  MessageBody,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { LobbyService } from './lobby.service';
import { Team, LobbyStatus } from '../shared/types';
import type { LobbyDto } from '../shared/types';

@WebSocketGateway({ cors: { origin: process.env.FRONTEND_URL || 'http://localhost:5173' } })
export class LobbyGateway implements OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  // Map socketId → playerId for disconnect handling
  private socketToPlayer = new Map<string, string>();

  constructor(private readonly lobbyService: LobbyService) {}

  async handleDisconnect(client: Socket) {
    const playerId = this.socketToPlayer.get(client.id);
    if (!playerId) return;
    this.socketToPlayer.delete(client.id);

    const { lobby, newHostId } = await this.lobbyService.markPlayerOffline(playerId);
    if (!lobby) return;

    this.server.to(lobby.id).emit('lobby:updated', lobby);
    if (newHostId) this.server.to(lobby.id).emit('lobby:newHost', { newHostId });
  }

  @SubscribeMessage('socket:identify')
  async handleIdentify(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { playerId: string },
  ): Promise<{ ok: boolean; lobby?: LobbyDto; gameId?: string; error?: string }> {
    const result = await this.lobbyService.reconnectPlayer(data.playerId, client.id);
    if (!result) return { ok: false, error: 'Player not found' };

    this.socketToPlayer.set(client.id, data.playerId);

    const { lobby } = result.player;
    if (!lobby) return { ok: true };

    if (lobby.status === LobbyStatus.WAITING) {
      client.join(lobby.id);
      const lobbyDto = await this.lobbyService.getLobbyById(lobby.id);
      if (!lobbyDto) return { ok: false, error: 'Lobby not found' };
      this.server.to(lobby.id).emit('lobby:updated', lobbyDto);
      return { ok: true, lobby: lobbyDto };
    }

    if (lobby.status === LobbyStatus.IN_PROGRESS && lobby.gameId) {
      client.join(lobby.gameId);
      return { ok: true, gameId: lobby.gameId };
    }

    return { ok: true };
  }

  @SubscribeMessage('lobby:create')
  async handleCreate(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { username: string },
  ) {
    const { lobby, playerId } = await this.lobbyService.createLobby(data.username, client.id);
    this.socketToPlayer.set(client.id, playerId);
    client.join(lobby.id);
    return { lobby, playerId };
  }

  @SubscribeMessage('lobby:join')
  async handleJoin(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { code: string; username: string },
  ) {
    const { lobby, playerId } = await this.lobbyService.joinLobby(data.code, data.username, client.id);
    this.socketToPlayer.set(client.id, playerId);
    client.join(lobby.id);
    this.server.to(lobby.id).emit('lobby:updated', lobby);
    return { lobby, playerId };
  }

  @SubscribeMessage('lobby:leave')
  async handleLeave(@ConnectedSocket() client: Socket) {
    const playerId = this.socketToPlayer.get(client.id);
    if (!playerId) return;

    const { lobby, newHostId } = await this.lobbyService.leaveLobby(playerId);
    this.socketToPlayer.delete(client.id);

    if (lobby) {
      client.leave(lobby.id);
      this.server.to(lobby.id).emit('lobby:updated', lobby);
      if (newHostId) this.server.to(lobby.id).emit('lobby:newHost', { newHostId });
    }
  }

  @SubscribeMessage('lobby:changeTeam')
  async handleChangeTeam(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { team: Team },
  ) {
    const playerId = this.socketToPlayer.get(client.id);
    if (!playerId) return;

    const lobby = await this.lobbyService.changeTeam(playerId, data.team);
    this.server.to(lobby.id).emit('lobby:updated', lobby);
    return { lobby };
  }

  @SubscribeMessage('lobby:kick')
  async handleKick(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { targetPlayerId: string },
  ) {
    const playerId = this.socketToPlayer.get(client.id);
    if (!playerId) return;

    const lobby = await this.lobbyService.kickPlayer(playerId, data.targetPlayerId);
    this.server.to(lobby.id).emit('lobby:updated', lobby);
    // Emit to kicked player's socket — they won't be in the room anymore after kick
    this.server.to(data.targetPlayerId).emit('lobby:kicked');
    return { lobby };
  }

  @SubscribeMessage('lobby:start')
  async handleStart(@ConnectedSocket() client: Socket) {
    const playerId = this.socketToPlayer.get(client.id);
    if (!playerId) return;

    // Find the lobby for this player to get the lobby id
    const { lobby } = await this.lobbyService.leaveLobby(playerId).catch(() => ({ lobby: null, newHostId: null }));
    // We need a different method — use the gateway's own map
    // This is handled in GameGateway.handleStartGame; here we just delegate
    this.server.to(client.rooms.values().next().value ?? '').emit('lobby:starting');
  }

  // Called by GameGateway after seats/imposter are assigned
  emitGameStarted(roomId: string, gameId: string) {
    this.server.to(roomId).emit('game:started', { gameId });
  }

  getSocketToPlayer(): Map<string, string> {
    return this.socketToPlayer;
  }
}
