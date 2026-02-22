import { io, Socket } from 'socket.io-client';
import { useGameStore } from '../store/gameStore';
import type { LobbyDto } from '../types';

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3001';
const STORAGE_KEY = 'chessus_identity';

let socket: Socket | null = null;

interface StoredIdentity {
  playerId: string;
  username: string;
}

export function saveIdentity(playerId: string, username: string): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ playerId, username }));
}

export function loadIdentity(): StoredIdentity | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as StoredIdentity) : null;
  } catch {
    return null;
  }
}

export function clearIdentity(): void {
  localStorage.removeItem(STORAGE_KEY);
}

export function getSocket(): Socket {
  if (!socket) {
    socket = io(BACKEND_URL, { autoConnect: false });

    socket.on('connect', () => {
      const identity = loadIdentity();
      if (!identity) return;

      socket!.emit(
        'socket:identify',
        { playerId: identity.playerId },
        (res: { ok: boolean; lobby?: LobbyDto; gameId?: string; error?: string }) => {
          const store = useGameStore.getState();

          if (!res.ok) {
            clearIdentity();
            store.reset();
            return;
          }

          if (!store.playerId) {
            store.setIdentity(identity.playerId, identity.username);
          }

          if (res.gameId) {
            store.setPendingGameId(res.gameId);
            // Request game state now that identification is complete, so the
            // backend can resolve our role from socketToPlayer without a race.
            socket!.emit('game:requestState', { gameId: res.gameId });
          } else if (res.lobby) {
            store.setLobby(res.lobby);
          }
        },
      );
    });
  }
  return socket;
}

export function connectSocket(): Socket {
  const s = getSocket();
  if (!s.connected) s.connect();
  return s;
}
