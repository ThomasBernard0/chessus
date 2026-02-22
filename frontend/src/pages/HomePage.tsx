import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { connectSocket, saveIdentity } from '../lib/socket';
import { useGameStore } from '../store/gameStore';
import type { LobbyDto } from '../types';

export default function HomePage() {
  const navigate = useNavigate();
  const { setIdentity, setLobby } = useGameStore();

  const [username, setUsername] = useState('');
  const [joinCode, setJoinCode] = useState('');
  const [mode, setMode] = useState<'idle' | 'join'>('idle');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  function validate() {
    if (!username.trim()) { setError('Enter a username'); return false; }
    setError('');
    return true;
  }

  async function handleCreate() {
    if (!validate()) return;
    setLoading(true);
    const socket = connectSocket();

    socket.emit('lobby:create', { username }, (res: { lobby: LobbyDto; playerId: string }) => {
      setLoading(false);
      saveIdentity(res.playerId, username);
      setIdentity(res.playerId, username);
      setLobby(res.lobby);
      navigate(`/lobby/${res.lobby.code}`);
    });
  }

  async function handleJoin() {
    if (!validate() || !joinCode.trim()) { setError('Enter a lobby code'); return; }
    setLoading(true);
    const socket = connectSocket();

    socket.emit('lobby:join', { code: joinCode.toUpperCase(), username }, (res: { lobby: LobbyDto; playerId: string } | { error: string }) => {
      setLoading(false);
      if ('error' in res) { setError(res.error); return; }
      saveIdentity(res.playerId, username);
      setIdentity(res.playerId, username);
      setLobby(res.lobby);
      navigate(`/lobby/${res.lobby.code}`);
    });
  }

  return (
    <div className="min-h-screen bg-gray-950 text-white flex flex-col items-center justify-center gap-8 p-6">
      <div className="text-center">
        <h1 className="text-6xl font-bold tracking-tight text-amber-400">Chessus</h1>
        <p className="mt-2 text-gray-400 text-lg">2v2 chess — but one of you is the imposter</p>
      </div>

      <div className="bg-gray-900 rounded-2xl p-8 w-full max-w-sm flex flex-col gap-4 shadow-xl">
        <input
          className="bg-gray-800 rounded-lg px-4 py-3 text-white placeholder-gray-500 outline-none focus:ring-2 focus:ring-amber-400"
          placeholder="Your username"
          value={username}
          onChange={e => setUsername(e.target.value)}
        />

        {error && <p className="text-red-400 text-sm">{error}</p>}

        {mode === 'idle' && (
          <>
            <button
              onClick={handleCreate}
              disabled={loading}
              className="bg-amber-400 hover:bg-amber-300 text-gray-950 font-semibold rounded-lg py-3 transition disabled:opacity-50"
            >
              Create Lobby
            </button>
            <button
              onClick={() => setMode('join')}
              className="bg-gray-700 hover:bg-gray-600 text-white font-semibold rounded-lg py-3 transition"
            >
              Join Lobby
            </button>
          </>
        )}

        {mode === 'join' && (
          <>
            <input
              className="bg-gray-800 rounded-lg px-4 py-3 text-white placeholder-gray-500 outline-none focus:ring-2 focus:ring-amber-400 uppercase tracking-widest"
              placeholder="Lobby code"
              value={joinCode}
              onChange={e => setJoinCode(e.target.value)}
              maxLength={6}
            />
            <button
              onClick={handleJoin}
              disabled={loading}
              className="bg-amber-400 hover:bg-amber-300 text-gray-950 font-semibold rounded-lg py-3 transition disabled:opacity-50"
            >
              Join
            </button>
            <button
              onClick={() => setMode('idle')}
              className="text-gray-500 hover:text-gray-300 text-sm transition"
            >
              Back
            </button>
          </>
        )}
      </div>
    </div>
  );
}
