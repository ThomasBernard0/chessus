import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Chessboard } from 'react-chessboard';
import { Chess } from 'chess.js';
import type { Square } from 'chess.js';
import { getSocket, clearIdentity } from '../lib/socket';
import { useGameStore } from '../store/gameStore';
import { Team } from '../types';
import type { GameState, MoveResult, VoteResult } from '../types';

const SEAT_LABEL = ['A1', 'B1', 'A2', 'B2'];

export default function GamePage() {
  const { gameId } = useParams<{ gameId: string }>();
  const navigate = useNavigate();
  const { game, myRole, playerId, setGame, updateFen, setVoteResult, setMyRole, voteResult, reset } = useGameStore();

  const [chess] = useState(() => new Chess());
  const [phase, setPhase] = useState<'playing' | 'voting' | 'finished'>('playing');
  const [winner, setWinner] = useState<Team | null>(null);
  const [selectedSuspect, setSelectedSuspect] = useState<string | null>(null);
  const [hasVoted, setHasVoted] = useState(false);
  const [selectedSquare, setSelectedSquare] = useState<string | null>(null);
  const [validMoveSquares, setValidMoveSquares] = useState<string[]>([]);

  useEffect(() => {
    const socket = getSocket();

    if (gameId) {
      socket.emit('game:requestState', { gameId });
    }

    socket.on('game:yourRole', setMyRole);

    socket.on('game:state', (state: GameState) => {
      setGame(state);
      chess.load(state.fen);
    });

    socket.on('game:moved', (result: MoveResult) => {
      chess.load(result.fen);
      updateFen(result.fen, result.currentTurn % 4, result.currentTurn);
      setSelectedSquare(null);
      setValidMoveSquares([]);
    });

    socket.on('game:votingStarted', ({ winner: w }: { winner: Team }) => {
      setWinner(w);
      setPhase('voting');
    });

    socket.on('game:voteUpdate', (result: VoteResult) => {
      setVoteResult(result);
    });

    socket.on('game:finished', (result: VoteResult) => {
      setVoteResult(result);
      setPhase('finished');
    });

    return () => {
      socket.off('game:yourRole');
      socket.off('game:state');
      socket.off('game:moved');
      socket.off('game:votingStarted');
      socket.off('game:voteUpdate');
      socket.off('game:finished');
    };
  }, []);

  // Returns the square of the king currently in check, or null.
  function getCheckSquare(): string | null {
    if (!chess.inCheck()) return null;
    const board = chess.board();
    const activeColor = chess.turn();
    for (let rank = 0; rank < 8; rank++) {
      for (let file = 0; file < 8; file++) {
        const piece = board[rank][file];
        if (piece?.type === 'k' && piece.color === activeColor) {
          return `${'abcdefgh'[file]}${8 - rank}`;
        }
      }
    }
    return null;
  }

  // Core move logic shared by drag-drop and click-to-move.
  function makeMove(from: string, to: string): boolean {
    if (!game || !myRole || !gameId) return false;

    const activePlayer = game.players.find(p => p.seatIndex === game.activeSeatIndex);
    if (!activePlayer || activePlayer.id !== playerId) return false;

    let move: ReturnType<Chess['move']> | null = null;
    try {
      move = chess.move({ from, to, promotion: 'q' });
    } catch {
      return false;
    }
    if (!move) return false;

    getSocket().emit('game:move', {
      gameId,
      from,
      to,
      san: move.san,
      fen: chess.fen(),
      promotion: move.promotion,
    });

    // Detect checkmate — winner is the side that is NOT to move next (they were mated).
    if (chess.isCheckmate()) {
      const checkmateWinner = chess.turn() === 'b' ? Team.A : Team.B;
      getSocket().emit('game:endGame', { gameId, winner: checkmateWinner });
    }

    return true;
  }

  function onDrop({ sourceSquare, targetSquare }: { sourceSquare: string; targetSquare: string | null }): boolean {
    if (!targetSquare) return false;
    const result = makeMove(sourceSquare, targetSquare);
    if (result) {
      setSelectedSquare(null);
      setValidMoveSquares([]);
    }
    return result;
  }

  function onSquareClick({ square }: { square: string; [k: string]: unknown }) {
    if (!game || phase !== 'playing') return;

    const activePlayer = game.players.find(p => p.seatIndex === game.activeSeatIndex);
    if (activePlayer?.id !== playerId) return;

    // Clicking on a valid target while a piece is selected → make the move.
    if (selectedSquare && validMoveSquares.includes(square)) {
      makeMove(selectedSquare, square);
      setSelectedSquare(null);
      setValidMoveSquares([]);
      return;
    }

    // Clicking on a piece that belongs to the active color → select it.
    const piece = chess.get(square as Square);
    if (piece && piece.color === chess.turn()) {
      setSelectedSquare(square);
      const moves = chess.moves({ square: square as Square, verbose: true });
      setValidMoveSquares(moves.map(m => m.to));
      return;
    }

    // Anything else → deselect.
    setSelectedSquare(null);
    setValidMoveSquares([]);
  }

  function handleVote() {
    if (!selectedSuspect || !gameId || hasVoted) return;
    setHasVoted(true);
    getSocket().emit('game:vote', { gameId, suspectId: selectedSuspect });
  }

  function endGame(w: Team) {
    getSocket().emit('game:endGame', { gameId, winner: w });
  }

  if (!game) return (
    <div className="min-h-screen bg-gray-950 text-white flex items-center justify-center">
      Loading game…
    </div>
  );

  const activeSeatLabel = SEAT_LABEL[game.activeSeatIndex] ?? '?';
  const activePlayer = game.players.find(p => p.seatIndex === game.activeSeatIndex);
  const isMyTurn = activePlayer?.id === playerId;

  // Build square highlight styles.
  const squareStyles: Record<string, object> = {};
  for (const sq of validMoveSquares) {
    const hasPiece = !!chess.get(sq as Square);
    squareStyles[sq] = hasPiece
      ? { background: 'radial-gradient(circle, transparent 58%, rgba(0,0,0,.25) 58%)', borderRadius: '50%' }
      : { background: 'radial-gradient(circle, rgba(0,0,0,.18) 25%, transparent 25%)' };
  }
  if (selectedSquare) {
    squareStyles[selectedSquare] = { backgroundColor: 'rgba(255, 213, 0, 0.5)' };
  }
  const checkSquare = getCheckSquare();
  if (checkSquare) {
    squareStyles[checkSquare] = { backgroundColor: 'rgba(220, 30, 30, 0.55)' };
  }

  return (
    <div className="min-h-screen bg-gray-950 text-white flex flex-col items-center justify-center gap-6 p-4">
      {myRole && (
        <div className={`px-4 py-2 rounded-full text-sm font-semibold ${myRole.isImposter ? 'bg-red-600' : 'bg-green-700'}`}>
          {myRole.isImposter ? 'You are the IMPOSTER — make your team lose!' : `Team ${myRole.team} — Seat ${SEAT_LABEL[myRole.seatIndex]}`}
        </div>
      )}

      {phase === 'playing' && (
        <>
          <div className="text-center">
            <p className="text-gray-400 text-sm">
              Turn: <span className="text-white font-semibold">{activeSeatLabel}</span>
              {isMyTurn && <span className="ml-2 text-amber-400 font-bold">— Your move!</span>}
            </p>
          </div>

          <div className="w-full max-w-[min(80vh,600px)]">
            <Chessboard
              options={{
                position: game.fen,
                onPieceDrop: onDrop,
                onSquareClick,
                allowDragging: isMyTurn,
                boardOrientation: myRole?.team === Team.B ? 'black' : 'white',
                squareStyles,
              }}
            />
          </div>

          {/* Dev helper — end game manually */}
          <div className="flex gap-2 text-xs text-gray-600">
            <button onClick={() => endGame(Team.A)} className="underline hover:text-gray-400">Force A wins</button>
            <button onClick={() => endGame(Team.B)} className="underline hover:text-gray-400">Force B wins</button>
          </div>
        </>
      )}

      {phase === 'voting' && (
        <div className="bg-gray-900 rounded-2xl p-8 w-full max-w-sm flex flex-col gap-4 shadow-xl">
          <h2 className="text-2xl font-bold text-amber-400 text-center">Who is the Imposter?</h2>
          {winner && <p className="text-center text-gray-400">Team <strong>{winner}</strong> won the chess match.</p>}

          <div className="flex flex-col gap-2">
            {game.players.filter(p => p.id !== playerId).map(p => (
              <button
                key={p.id}
                onClick={() => setSelectedSuspect(p.id)}
                className={`rounded-lg px-4 py-3 text-left transition ${selectedSuspect === p.id ? 'bg-amber-400 text-gray-950' : 'bg-gray-800 hover:bg-gray-700'}`}
              >
                {p.username} — Seat {SEAT_LABEL[p.seatIndex]}
              </button>
            ))}
          </div>

          <button
            onClick={handleVote}
            disabled={!selectedSuspect || hasVoted}
            className="bg-red-600 hover:bg-red-500 text-white font-semibold rounded-lg py-3 transition disabled:opacity-40"
          >
            {hasVoted ? 'Vote cast!' : 'Cast Vote'}
          </button>

          {voteResult && (
            <p className="text-center text-gray-400 text-sm">
              {voteResult.votes.length}/{voteResult.totalPlayers} votes cast
            </p>
          )}
        </div>
      )}

      {phase === 'finished' && voteResult && (
        <div className="bg-gray-900 rounded-2xl p-8 w-full max-w-sm flex flex-col gap-4 shadow-xl text-center">
          <h2 className="text-2xl font-bold text-amber-400">Game Over</h2>
          {voteResult.eliminatedPlayerId ? (
            <>
              <p className="text-gray-300">
                The most-voted player was{' '}
                <strong>{game.players.find(p => p.id === voteResult.eliminatedPlayerId)?.username}</strong>.
              </p>
              <p className={`text-2xl font-bold ${voteResult.wasImposterFound ? 'text-green-400' : 'text-red-400'}`}>
                {voteResult.wasImposterFound ? 'Imposter found!' : 'Wrong! The imposter escaped.'}
              </p>
            </>
          ) : (
            <p className="text-gray-300">Tie vote — imposter escaped!</p>
          )}
          <button onClick={() => { clearIdentity(); reset(); navigate('/'); }} className="bg-amber-400 hover:bg-amber-300 text-gray-950 font-semibold rounded-lg py-3 transition">
            Back to Home
          </button>
        </div>
      )}
    </div>
  );
}
