import { BrowserRouter, Routes, Route, useNavigate, useLocation } from 'react-router-dom';
import { useEffect } from 'react';
import { connectSocket } from './lib/socket';
import { useGameStore } from './store/gameStore';
import HomePage from './pages/HomePage';
import LobbyPage from './pages/LobbyPage';
import GamePage from './pages/GamePage';

function AppRoutes() {
  const navigate = useNavigate();
  const location = useLocation();
  const { pendingGameId, setPendingGameId, lobby } = useGameStore();

  useEffect(() => {
    connectSocket();
  }, []);

  useEffect(() => {
    if (pendingGameId) {
      setPendingGameId(null);
      navigate(`/game/${pendingGameId}`);
    }
  }, [pendingGameId]);

  useEffect(() => {
    if (lobby && location.pathname === '/') {
      navigate(`/lobby/${lobby.code}`);
    }
  }, [lobby]);

  return (
    <Routes>
      <Route path="/" element={<HomePage />} />
      <Route path="/lobby/:code" element={<LobbyPage />} />
      <Route path="/game/:gameId" element={<GamePage />} />
    </Routes>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AppRoutes />
    </BrowserRouter>
  );
}
