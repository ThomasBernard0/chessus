import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  ConnectedSocket,
  MessageBody,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { GameService } from './game.service';
import { LobbyService } from '../lobby/lobby.service';
import { LobbyGateway } from '../lobby/lobby.gateway';

@WebSocketGateway({ cors: { origin: process.env.FRONTEND_URL || 'http://localhost:5173' } })
export class GameGateway {
  @WebSocketServer()
  server: Server;

  constructor(
    private readonly gameService: GameService,
    private readonly lobbyService: LobbyService,
    private readonly lobbyGateway: LobbyGateway,
  ) {}

  @SubscribeMessage('game:start')
  async handleStartGame(@ConnectedSocket() client: Socket) {
    const socketToPlayer = this.lobbyGateway.getSocketToPlayer();
    const playerId = socketToPlayer.get(client.id);
    if (!playerId) return { error: 'Not identified' };

    const lobbyId = await this.lobbyService.getPlayerLobbyId(playerId);
    if (!lobbyId) return { error: 'Not in a lobby' };

    try {
      await this.lobbyService.assignSeatsAndImposter(lobbyId);
      const { gameId } = await this.gameService.startGame(lobbyId);
      const state = await this.gameService.getGameState(gameId);

      // Join all players to the game room and send their role privately
      for (const player of state.lobby.players) {
        const playerSocket = [...this.server.sockets.sockets.values()].find(
          s => s.id === player.socketId,
        );
        if (playerSocket) {
          playerSocket.join(gameId);
          playerSocket.emit('game:yourRole', {
            isImposter: player.isImposter,
            team: player.team,
            seatIndex: player.seatIndex,
          });
        }
      }

      // Emit game:started to lobby room AFTER all sockets have joined the game room.
      // game:state is NOT emitted here — GamePage requests it on mount via game:requestState
      // to avoid the race condition where GamePage hasn't mounted yet.
      this.lobbyGateway.emitGameStarted(lobbyId, gameId);
      return { gameId };
    } catch (err: any) {
      return { error: err?.message ?? 'Failed to start game' };
    }
  }

  @SubscribeMessage('game:requestState')
  async handleRequestState(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { gameId: string },
  ) {
    try {
      const state = await this.gameService.getGameState(data.gameId);
      const activeSeatIndex = state.moves.length % 4;

      const currentFen = state.moves.length > 0
        ? state.moves[state.moves.length - 1].fen
        : state.fen;

      const gameState = {
        gameId: state.id,
        fen: currentFen,
        moves: state.moves.map(m => ({ from: m.from, to: m.to, san: m.san })),
        activeSeatIndex,
        players: state.lobby.players.map(p => ({
          id: p.id,
          username: p.username,
          team: p.team,
          seatIndex: p.seatIndex,
        })),
      };

      // Ensure this socket is in the game room
      client.join(data.gameId);
      client.emit('game:state', gameState);

      // Re-emit role so GamePage always has it (handles missed game:yourRole during navigation)
      const playerId = this.lobbyGateway.getSocketToPlayer().get(client.id);
      if (playerId) {
        const player = state.lobby.players.find(p => p.id === playerId);
        if (player) {
          client.emit('game:yourRole', {
            isImposter: player.isImposter,
            team: player.team,
            seatIndex: player.seatIndex,
          });
        }
      }
    } catch {
      client.emit('game:error', { message: 'Game not found' });
    }
  }

  @SubscribeMessage('game:move')
  async handleMove(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { gameId: string; from: string; to: string; san: string; fen: string; promotion?: string },
  ) {
    const socketToPlayer = this.lobbyGateway.getSocketToPlayer();
    const playerId = socketToPlayer.get(client.id);
    if (!playerId) return { error: 'Not identified' };

    const result = await this.gameService.applyMove(
      data.gameId,
      playerId,
      data.from,
      data.to,
      data.san,
      data.fen,
      data.promotion,
    );

    this.server.to(data.gameId).emit('game:moved', result);

    if (result.isGameOver) {
      this.server.to(data.gameId).emit('game:votingStarted', { winner: result.winner });
    }

    return result;
  }

  @SubscribeMessage('game:vote')
  async handleVote(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { gameId: string; suspectId: string },
  ) {
    const socketToPlayer = this.lobbyGateway.getSocketToPlayer();
    const playerId = socketToPlayer.get(client.id);
    if (!playerId) return { error: 'Not identified' };

    const result = await this.gameService.castVote(data.gameId, playerId, data.suspectId);
    this.server.to(data.gameId).emit('game:voteUpdate', result);

    if (result.isVotingComplete) {
      this.server.to(data.gameId).emit('game:finished', result);
    }

    return result;
  }

  @SubscribeMessage('game:returnToLobby')
  async handleReturnToLobby(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { gameId: string },
  ) {
    let lobbyId: string | null = null;

    try {
      const game = await this.gameService.getGameState(data.gameId);
      lobbyId = game.lobbyId;
    } catch {
      // Game already cleaned up — look up lobby via player
      const playerId = this.lobbyGateway.getSocketToPlayer().get(client.id);
      if (playerId) lobbyId = await this.lobbyService.getPlayerLobbyId(playerId);
    }

    if (!lobbyId) return { error: 'Cannot determine lobby' };

    const lobby = await this.lobbyService.resetAfterGame(lobbyId);
    if (!lobby) return { error: 'Lobby not found' };

    // Move all sockets from the game room into the lobby room
    const roomSockets = await this.server.in(data.gameId).fetchSockets();
    for (const s of roomSockets) {
      s.join(lobbyId);
      s.leave(data.gameId);
    }

    this.server.to(lobbyId).emit('lobby:returnedToLobby', { lobby });
  }

  @SubscribeMessage('game:endGame')
  async handleEndGame(
    @ConnectedSocket() _client: Socket,
    @MessageBody() data: { gameId: string; winner: 'A' | 'B' },
  ) {
    await this.gameService.endGame(data.gameId, data.winner as any);
    this.server.to(data.gameId).emit('game:votingStarted', { winner: data.winner });
  }
}
