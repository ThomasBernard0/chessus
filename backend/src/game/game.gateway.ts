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
import { Team } from '../shared/types';

const INITIAL_TIME_MS = 15 * 1000; // 10 minutes
const INCREMENT_MS = 3 * 1000; // +3s per allied move
const TICK_INTERVAL_MS = 1000;

interface GameTimer {
  teamAMs: number; // remaining ms for Team A (White)
  teamBMs: number; // remaining ms for Team B (Black)
  activeTeam: Team;
  lastTickAt: number; // Date.now() at last tick
  intervalId: ReturnType<typeof setInterval>;
}

@WebSocketGateway({
  cors: { origin: process.env.FRONTEND_URL || true, credentials: true },
})
export class GameGateway {
  @WebSocketServer()
  server: Server;

  // In-memory timers per gameId
  private timers = new Map<string, GameTimer>();

  constructor(
    private readonly gameService: GameService,
    private readonly lobbyService: LobbyService,
    private readonly lobbyGateway: LobbyGateway,
  ) {}

  // ---------- helpers ----------

  private startTimer(gameId: string, activeTeam: Team) {
    const timer: GameTimer = {
      teamAMs: INITIAL_TIME_MS,
      teamBMs: INITIAL_TIME_MS,
      activeTeam,
      lastTickAt: Date.now(),
      intervalId: setInterval(() => this.tick(gameId), TICK_INTERVAL_MS),
    };
    this.timers.set(gameId, timer);
  }

  private stopTimer(gameId: string) {
    const timer = this.timers.get(gameId);
    if (timer) {
      clearInterval(timer.intervalId);
      this.timers.delete(gameId);
    }
  }

  private tick(gameId: string) {
    const timer = this.timers.get(gameId);
    if (!timer) return;

    const now = Date.now();
    const elapsed = now - timer.lastTickAt;
    timer.lastTickAt = now;

    if (timer.activeTeam === Team.A) {
      timer.teamAMs = Math.max(0, timer.teamAMs - elapsed);
    } else {
      timer.teamBMs = Math.max(0, timer.teamBMs - elapsed);
    }

    this.server.to(gameId).emit('game:timerUpdate', {
      teamAMs: timer.teamAMs,
      teamBMs: timer.teamBMs,
      activeTeam: timer.activeTeam,
    });

    // Timeout: the team whose clock hit 0 loses → the other team wins
    if (timer.teamAMs === 0 || timer.teamBMs === 0) {
      const winner = timer.teamAMs === 0 ? Team.B : Team.A;
      this.stopTimer(gameId);
      this.gameService
        .endGame(gameId, winner)
        .then(() => {
          this.server.to(gameId).emit('game:votingStarted', { winner });
        })
        .catch(() => {});
    }
  }

  getTimerState(gameId: string) {
    const timer = this.timers.get(gameId);
    if (!timer) return null;
    return {
      teamAMs: timer.teamAMs,
      teamBMs: timer.teamBMs,
      activeTeam: timer.activeTeam,
    };
  }

  // ---------- handlers ----------

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
          (s) => s.id === player.socketId,
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

      // Start the timer — Team A (White) goes first (seat 0)
      this.startTimer(gameId, Team.A);

      // Emit game:started to lobby room AFTER all sockets have joined the game room.
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

      const currentFen =
        state.moves.length > 0
          ? state.moves[state.moves.length - 1].fen
          : state.fen;

      const timerState = this.getTimerState(data.gameId);

      const gameState = {
        gameId: state.id,
        fen: currentFen,
        moves: state.moves.map((m) => ({ from: m.from, to: m.to, san: m.san })),
        activeSeatIndex,
        players: state.lobby.players.map((p) => ({
          id: p.id,
          username: p.username,
          team: p.team,
          seatIndex: p.seatIndex,
        })),
        timer: timerState,
      };

      // Ensure this socket is in the game room
      client.join(data.gameId);
      client.emit('game:state', gameState);

      // Re-emit role so GamePage always has it (handles missed game:yourRole during navigation)
      const playerId = this.lobbyGateway.getSocketToPlayer().get(client.id);
      if (playerId) {
        const player = state.lobby.players.find((p) => p.id === playerId);
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
    @MessageBody()
    data: {
      gameId: string;
      from: string;
      to: string;
      san: string;
      fen: string;
      promotion?: string;
    },
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

    // Apply +3s increment to the team that just moved, then switch active team
    const timer = this.timers.get(data.gameId);
    if (timer) {
      if (timer.activeTeam === Team.A) {
        timer.teamAMs = Math.min(timer.teamAMs + INCREMENT_MS, INITIAL_TIME_MS);
        timer.activeTeam = Team.B;
      } else {
        timer.teamBMs = Math.min(timer.teamBMs + INCREMENT_MS, INITIAL_TIME_MS);
        timer.activeTeam = Team.A;
      }
      timer.lastTickAt = Date.now();
    }

    const timerState = this.getTimerState(data.gameId);
    this.server
      .to(data.gameId)
      .emit('game:moved', { ...result, timer: timerState });

    if (result.isGameOver) {
      this.stopTimer(data.gameId);
      this.server
        .to(data.gameId)
        .emit('game:votingStarted', { winner: result.winner });
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

    const result = await this.gameService.castVote(
      data.gameId,
      playerId,
      data.suspectId,
    );
    this.server.to(data.gameId).emit('game:voteUpdate', result);

    if (result.isVotingComplete) {
      const pointsAwarded = await this.gameService.awardPoints(data.gameId);
      this.server
        .to(data.gameId)
        .emit('game:finished', { ...result, pointsAwarded });
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
      if (playerId)
        lobbyId = await this.lobbyService.getPlayerLobbyId(playerId);
    }

    if (!lobbyId) return { error: 'Cannot determine lobby' };

    const lobby = await this.lobbyService.resetAfterGame(lobbyId);
    if (!lobby) return { error: 'Lobby not found' };

    // Stop timer if still running
    this.stopTimer(data.gameId);

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
    this.stopTimer(data.gameId);
    await this.gameService.endGame(data.gameId, data.winner as any);
    this.server
      .to(data.gameId)
      .emit('game:votingStarted', { winner: data.winner });
  }
}
