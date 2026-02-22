import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { getSocket, clearIdentity } from '../lib/socket';
import { useGameStore } from '../store/gameStore';
import { Team } from '../types';
import type { LobbyDto } from '../types';

const TEAM_LABEL: Record<Team, string> = { A: 'Team A', B: 'Team B' };
const TEAM_COLOR: Record<Team, string> = { A: 'bg-white text-gray-900', B: 'bg-gray-800 text-white' };

export default function LobbyPage() {
  const { code: _code } = useParams<{ code: string }>();
  const navigate = useNavigate();
  const { lobby, playerId, setLobby, setMyRole } = useGameStore();
  const [startError, setStartError] = useState('');

  useEffect(() => {
    const socket = getSocket();

    socket.on('lobby:updated', (updated: LobbyDto) => setLobby(updated));
    socket.on('lobby:kicked', () => {
      setLobby(null);
      navigate('/');
    });
    socket.on('game:started', ({ gameId }: { gameId: string }) => {
      navigate(`/game/${gameId}`);
    });
    socket.on('game:yourRole', (role: { isImposter: boolean; team: Team; seatIndex: number }) => {
      setMyRole(role);
    });

    return () => {
      socket.off('lobby:updated');
      socket.off('lobby:kicked');
      socket.off('game:started');
      socket.off('game:yourRole');
    };
  }, []);

  if (!lobby) {
    return (
      <div className="min-h-screen bg-gray-950 flex items-center justify-center text-white">
        Lobby not found. <button onClick={() => navigate('/')} className="ml-2 underline">Go home</button>
      </div>
    );
  }

  const isHost = lobby.hostId === playerId;
  const myPlayer = lobby.players.find(p => p.id === playerId);
  const allOnline = lobby.players.every(p => p.isOnline);
  const canStart = isHost && lobby.players.length === 4 &&
    lobby.players.filter(p => p.team === Team.A).length === 2 &&
    lobby.players.filter(p => p.team === Team.B).length === 2 &&
    allOnline;

  function handleChangeTeam(team: Team) {
    getSocket().emit('lobby:changeTeam', { team });
  }

  function handleKick(targetId: string) {
    getSocket().emit('lobby:kick', { targetPlayerId: targetId });
  }

  function handleStart() {
    setStartError('');
    getSocket().emit('game:start', {}, (res: { gameId?: string; error?: string }) => {
      if (res?.error) setStartError(res.error);
    });
  }

  function handleLeave() {
    clearIdentity();
    getSocket().emit('lobby:leave');
    setLobby(null);
    navigate('/');
  }

  return (
    <div className="min-h-screen bg-gray-950 text-white flex flex-col items-center justify-center gap-6 p-6">
      <div className="text-center">
        <h1 className="text-3xl font-bold text-amber-400">Lobby</h1>
        <p className="text-gray-400 mt-1">
          Code: <span className="font-mono text-white tracking-widest text-xl">{lobby.code}</span>
        </p>
      </div>

      <div className="bg-gray-900 rounded-2xl p-6 w-full max-w-md flex flex-col gap-4 shadow-xl">
        <p className="text-gray-400 text-sm">{lobby.players.length}/4 players</p>

        {[Team.A, Team.B].map(team => (
          <div key={team}>
            <h3 className="text-sm font-semibold text-gray-400 mb-2">{TEAM_LABEL[team]}</h3>
            <div className="flex flex-col gap-2">
              {lobby.players
                .filter(p => p.team === team)
                .map(p => (
                  <div key={p.id} className={`flex items-center justify-between rounded-lg px-4 py-2 ${TEAM_COLOR[team]}`}>
                    <span className="font-medium">
                      {p.username}
                      {!p.isOnline && <span className="ml-2 text-xs text-gray-500">(offline)</span>}
                      {p.isHost && <span className="ml-2 text-xs text-amber-500">(host)</span>}
                      {p.id === playerId && <span className="ml-2 text-xs text-green-400">(you)</span>}
                    </span>
                    {isHost && p.id !== playerId && (
                      <button
                        onClick={() => handleKick(p.id)}
                        className="text-red-400 hover:text-red-300 text-xs transition"
                      >
                        Kick
                      </button>
                    )}
                  </div>
                ))}
            </div>
          </div>
        ))}

        {lobby.players.filter(p => !p.team).length > 0 && (
          <div>
            <h3 className="text-sm font-semibold text-gray-400 mb-2">Unassigned</h3>
            {lobby.players
              .filter(p => !p.team)
              .map(p => (
                <div key={p.id} className="flex items-center justify-between rounded-lg px-4 py-2 bg-gray-800">
                  <span>{p.username}{p.id === playerId && <span className="ml-2 text-xs text-green-400">(you)</span>}</span>
                </div>
              ))}
          </div>
        )}

        {/* Team switcher for self */}
        {myPlayer && (
          <div className="flex gap-2 pt-2">
            <button
              onClick={() => handleChangeTeam(Team.A)}
              disabled={myPlayer.team === Team.A}
              className="flex-1 bg-gray-700 hover:bg-white hover:text-gray-900 rounded-lg py-2 text-sm transition disabled:opacity-40"
            >
              Join Team A
            </button>
            <button
              onClick={() => handleChangeTeam(Team.B)}
              disabled={myPlayer.team === Team.B}
              className="flex-1 bg-gray-700 hover:bg-gray-600 rounded-lg py-2 text-sm transition disabled:opacity-40"
            >
              Join Team B
            </button>
          </div>
        )}

        {isHost && (
          <>
            <button
              onClick={handleStart}
              disabled={!canStart}
              className="bg-amber-400 hover:bg-amber-300 text-gray-950 font-semibold rounded-lg py-3 transition disabled:opacity-40 mt-2"
            >
              {canStart ? 'Start Game' : !allOnline ? 'Waiting for players to reconnect' : 'Need 2 players on each team'}
            </button>
            {startError && <p className="text-red-400 text-sm text-center">{startError}</p>}
          </>
        )}

        <button onClick={handleLeave} className="text-gray-500 hover:text-gray-300 text-sm transition">
          Leave lobby
        </button>
      </div>

      {/* Leaderboard */}
      <div className="bg-gray-900 rounded-2xl p-6 w-full max-w-md flex flex-col gap-3 shadow-xl">
        <h2 className="text-sm font-semibold text-gray-400">Leaderboard</h2>
        {[...lobby.players]
          .sort((a, b) => b.points - a.points)
          .map((p, i) => (
            <div
              key={p.id}
              className={`flex items-center gap-3 rounded-lg px-4 py-2 ${p.id === playerId ? 'bg-amber-400/10 border border-amber-400/30' : 'bg-gray-800'}`}
            >
              <span className="text-gray-500 text-sm w-4">{i + 1}</span>
              <span className="flex-1 text-sm">
                {p.username}
                {p.id === playerId && <span className="ml-2 text-xs text-green-400">(you)</span>}
              </span>
              <span className="font-bold text-amber-400">{p.points} pts</span>
            </div>
          ))}
      </div>
    </div>
  );
}
