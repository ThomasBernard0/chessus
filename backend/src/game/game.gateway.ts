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

    // Find the player's lobby and validate they are the host
    // The room the client is in (besides their own socket room) is the lobby id
    const rooms = [...client.rooms].filter(r => r !== client.id);
    const lobbyId = rooms[0];
    if (!lobbyId) return { error: 'Not in a lobby' };

    await this.lobbyService.assignSeatsAndImposter(lobbyId);
    const { gameId, activeSeatIndex } = await this.gameService.startGame(lobbyId);

    const state = await this.gameService.getGameState(gameId);

    // Tell each player their role privately
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

    this.lobbyGateway.emitGameStarted(lobbyId, gameId);
    this.server.to(gameId).emit('game:state', {
      gameId,
      fen: state.fen,
      moves: state.moves,
      activeSeatIndex,
      players: state.lobby.players.map(p => ({
        id: p.id,
        username: p.username,
        team: p.team,
        seatIndex: p.seatIndex,
      })),
    });

    return { gameId };
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

  @SubscribeMessage('game:endGame')
  async handleEndGame(
    @ConnectedSocket() _client: Socket,
    @MessageBody() data: { gameId: string; winner: 'A' | 'B' },
  ) {
    await this.gameService.endGame(data.gameId, data.winner as any);
    this.server.to(data.gameId).emit('game:votingStarted', { winner: data.winner });
  }
}
