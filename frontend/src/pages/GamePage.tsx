import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Chessboard } from 'react-chessboard';
import { Chess } from 'chess.js';
import type { Square } from 'chess.js';
import { getSocket, clearIdentity } from '../lib/socket';
import { useGameStore } from '../store/gameStore';
import { Team } from '../types';
import type { GameState, MoveResult, VoteResult, PointAward, LobbyDto } from '../types';


// --- Timer helpers ---
function formatTime(ms: number): string {
  const totalSeconds = Math.ceil(ms / 1000);
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

// --- Captured pieces helpers ---
const PIECE_VALUES: Record<string, number> = { p: 1, n: 3, b: 3, r: 5, q: 9 };
const STARTING_COUNT: Record<string, number> = { p: 8, n: 2, b: 2, r: 2, q: 1 };
const DISPLAY_ORDER = ['q', 'r', 'b', 'n', 'p'] as const;
// Single symbol set — differentiate color via CSS to avoid ♟ rendering inconsistencies across fonts
const PIECE_SYMBOLS: Record<string, string> = { p: '♙', n: '♘', b: '♗', r: '♖', q: '♕' };

function computeCaptures(fen: string) {
  const boardPart = fen.split(' ')[0];
  const count: Record<string, number> = {};
  for (const ch of boardPart) {
    if ('pnbrqkPNBRQK'.includes(ch)) count[ch] = (count[ch] ?? 0) + 1;
  }
  const capturedByWhite: Record<string, number> = {};
  const capturedByBlack: Record<string, number> = {};
  let advantage = 0;
  for (const [piece, start] of Object.entries(STARTING_COUNT)) {
    const bCaptured = start - (count[piece] ?? 0);
    const wCaptured = start - (count[piece.toUpperCase()] ?? 0);
    if (bCaptured > 0) capturedByWhite[piece] = bCaptured;
    if (wCaptured > 0) capturedByBlack[piece] = wCaptured;
    advantage += bCaptured * PIECE_VALUES[piece];
    advantage -= wCaptured * PIECE_VALUES[piece];
  }
  return { capturedByWhite, capturedByBlack, advantage };
}

function CapturedPiecesRow({
  captured, pieceColor, advantage,
}: {
  captured: Record<string, number>;
  pieceColor: 'w' | 'b';
  advantage: number;
}) {
  // White pieces: pure white + dark shadow. Black pieces: dark fill + white glow for visibility on dark bg.
  const style = pieceColor === 'w'
    ? { color: '#ffffff', textShadow: '0 0 2px rgba(0,0,0,0.9), 0 1px 3px rgba(0,0,0,0.6)', letterSpacing: '-0.05em' }
    : { color: '#111111', textShadow: '0 0 1px rgba(255,255,255,0.9), 0 0 4px rgba(255,255,255,0.7)', letterSpacing: '-0.05em' };

  const groups = DISPLAY_ORDER.filter(p => (captured[p] ?? 0) > 0);

  return (
    <div className="flex items-center gap-1.5 min-h-[1.5rem]">
      {groups.map(p => (
        <div key={p} className="flex items-center">
          {Array.from({ length: captured[p] }).map((_, i) => (
            <span key={i} className="text-lg leading-none" style={{ ...style, marginLeft: i === 0 ? 0 : '-0.35em' }}>
              {PIECE_SYMBOLS[p]}
            </span>
          ))}
        </div>
      ))}
      {advantage > 0 && (
        <span className="text-xs text-gray-400 font-semibold ml-1">+{advantage}</span>
      )}
    </div>
  );
}

export default function GamePage() {
  const { gameId } = useParams<{ gameId: string }>();
  const navigate = useNavigate();
  const { game, myRole, playerId, setGame, updateFen, updateTimer, setVoteResult, setPointsAwarded, setMyRole, voteResult, pointsAwarded, reset, setLobby } = useGameStore();

  const [chess] = useState(() => new Chess());
  const [phase, setPhase] = useState<'playing' | 'voting' | 'finished'>('playing');
  const [winner, setWinner] = useState<'White' | 'Black' | null>(null);
  const [selectedSuspect, setSelectedSuspect] = useState<string | null>(null);
  const [hasVoted, setHasVoted] = useState(false);
  const [selectedSquare, setSelectedSquare] = useState<string | null>(null);
  const [validMoveSquares, setValidMoveSquares] = useState<string[]>([]);

  useEffect(() => {
    const socket = getSocket();

    // Only request state immediately if already connected+identified (normal navigation).
    // On page reload the socket isn't connected yet; socket.ts emits this after identify completes.
    if (gameId && socket.connected) {
      socket.emit('game:requestState', { gameId });
    }

    socket.on('game:yourRole', setMyRole);

    socket.on('game:state', (state: GameState) => {
      setGame(state);
      chess.load(state.fen);
    });

    socket.on('game:moved', (result: MoveResult) => {
      chess.load(result.fen);
      updateFen(result.fen, result.currentTurn % 4, result.currentTurn, result.timer);
      setSelectedSquare(null);
      setValidMoveSquares([]);
    });

    socket.on('game:timerUpdate', updateTimer);

    socket.on('game:votingStarted', ({ winner: w }: { winner: Team }) => {
      setWinner(w === Team.A ? 'White' : 'Black');
      setPhase('voting');
    });

    socket.on('game:voteUpdate', (result: VoteResult) => {
      setVoteResult(result);
    });

    socket.on('game:finished', (result: VoteResult & { pointsAwarded: PointAward[] }) => {
      setVoteResult(result);
      setPointsAwarded(result.pointsAwarded);
      setPhase('finished');
    });

    socket.on('lobby:returnedToLobby', ({ lobby }: { lobby: LobbyDto }) => {
      reset();
      setLobby(lobby);
      navigate(`/lobby/${lobby.code}`);
    });

    return () => {
      socket.off('game:yourRole');
      socket.off('game:state');
      socket.off('game:moved');
      socket.off('game:votingStarted');
      socket.off('game:voteUpdate');
      socket.off('game:finished');
      socket.off('lobby:returnedToLobby');
      socket.off('game:timerUpdate');
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
      // White players are in even seats; determine their team from game state.
      const whiteTeam = game.players.find(p => p.seatIndex === 0)?.team ?? Team.A;
      const blackTeam = whiteTeam === Team.A ? Team.B : Team.A;
      const checkmateWinner = chess.turn() === 'b' ? whiteTeam : blackTeam;
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

  function handleLeaveGame() {
    clearIdentity();
    reset();
    navigate('/');
  }

  if (!game) return (
    <div className="min-h-screen bg-gray-950 text-white flex items-center justify-center">
      Loading game…
    </div>
  );

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
          {myRole.isImposter ? 'You are the IMPOSTER — make your team lose!' : `You are a Loyalist — win as ${myRole.seatIndex % 2 === 0 ? 'White' : 'Black'}!`}
        </div>
      )}

      {phase === 'playing' && (
        <>
          <div className="text-center">
            <p className="text-gray-400 text-sm">
              Turn: <span className="text-white font-semibold">{activePlayer?.username ?? '?'}</span>
              {isMyTurn && <span className="ml-2 text-amber-400 font-bold">— Your move!</span>}
            </p>
          </div>

          <div className="w-full max-w-[min(80vh,600px)] flex flex-col gap-1">
            {(() => {
              const { capturedByWhite, capturedByBlack, advantage } = computeCaptures(game.fen);
              const isBlack = myRole != null && myRole.seatIndex % 2 === 1;
              const whiteRow = <CapturedPiecesRow captured={capturedByWhite} pieceColor="b" advantage={advantage > 0 ? advantage : 0} />;
              const blackRow = <CapturedPiecesRow captured={capturedByBlack} pieceColor="w" advantage={advantage < 0 ? -advantage : 0} />;

              // Clocks: opponent's at top, ours at bottom (matches board orientation)
              const timer = game.timer;
              const myTeam = myRole?.seatIndex !== undefined ? (myRole.seatIndex % 2 === 0 ? 'A' : 'B') : null;
              const myMs = myTeam === 'A' ? (timer?.teamAMs ?? null) : (timer?.teamBMs ?? null);
              const oppMs = myTeam === 'A' ? (timer?.teamBMs ?? null) : (timer?.teamAMs ?? null);
              const myTeamActive = timer?.activeTeam === (myTeam === 'A' ? 'A' : 'B');

              function Clock({ ms, active, label }: { ms: number | null; active: boolean; label: string }) {
                const low = ms !== null && ms < 30_000;
                return (
                  <div className={`flex items-center justify-between px-3 py-1.5 rounded-lg ${active ? 'bg-gray-700' : 'bg-gray-800'}`}>
                    <span className="text-xs text-gray-400">{label}</span>
                    <span className={`font-mono font-bold text-lg tabular-nums ${low ? 'text-red-400' : active ? 'text-white' : 'text-gray-400'}`}>
                      {ms !== null ? formatTime(ms) : '--:--'}
                    </span>
                  </div>
                );
              }

              return (
                <>
                  <Clock ms={oppMs} active={!myTeamActive} label={isBlack ? 'White' : 'Black'} />
                  {isBlack ? whiteRow : blackRow}
                  <Chessboard
                    options={{
                      position: game.fen,
                      onPieceDrop: onDrop,
                      onSquareClick,
                      allowDragging: isMyTurn,
                      boardOrientation: isBlack ? 'black' : 'white',
                      squareStyles,
                    }}
                  />
                  {isBlack ? blackRow : whiteRow}
                  <Clock ms={myMs} active={myTeamActive} label={isBlack ? 'Black' : 'White'} />
                </>
              );
            })()}
          </div>

          <button onClick={handleLeaveGame} className="text-gray-500 hover:text-gray-300 text-sm transition">
            Leave game
          </button>
        </>
      )}

      {phase === 'voting' && (
        <div className="bg-gray-900 rounded-2xl p-8 w-full max-w-sm flex flex-col gap-4 shadow-xl">
          <h2 className="text-2xl font-bold text-amber-400 text-center">Who is the Imposter?</h2>
          {winner && <p className="text-center text-gray-400"><strong>{winner}</strong> won the chess match.</p>}

          <div className="flex flex-col gap-2">
            {game.players.filter(p => p.id !== playerId).map(p => (
              <button
                key={p.id}
                onClick={() => !hasVoted && setSelectedSuspect(p.id)}
                disabled={hasVoted}
                className={`rounded-lg px-4 py-3 text-left transition ${selectedSuspect === p.id ? 'bg-amber-400 text-gray-950' : 'bg-gray-800 hover:bg-gray-700'} disabled:cursor-default disabled:opacity-70`}
              >
                {p.username}
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

          <button onClick={handleLeaveGame} className="text-gray-500 hover:text-gray-300 text-sm transition">
            Leave game
          </button>
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
              <p className={`text-2xl font-bold ${voteResult.wasImposterFound ? 'text-green-400' : myRole?.isImposter && voteResult.imposterPlayerId === playerId ? 'text-amber-400' : 'text-red-400'}`}>
                {voteResult.wasImposterFound
                  ? 'Imposter found!'
                  : myRole?.isImposter && voteResult.imposterPlayerId === playerId
                    ? 'You escaped! You win!'
                    : 'Wrong! The imposter escaped.'}
              </p>
              {!voteResult.wasImposterFound && voteResult.imposterPlayerId && (
                <p className="text-gray-400 text-sm">
                  The imposter was <strong className="text-white">{game.players.find(p => p.id === voteResult.imposterPlayerId)?.username}</strong>.
                </p>
              )}
            </>
          ) : (
            <>
              <p className={`text-2xl font-bold ${myRole?.isImposter && voteResult.imposterPlayerId === playerId ? 'text-amber-400' : 'text-gray-300'}`}>
                {myRole?.isImposter && voteResult.imposterPlayerId === playerId ? 'You escaped! You win!' : 'Tie vote — imposter escaped!'}
              </p>
              {voteResult.imposterPlayerId && (
                <p className="text-gray-400 text-sm">
                  The imposter was <strong className="text-white">{game.players.find(p => p.id === voteResult.imposterPlayerId)?.username}</strong>.
                </p>
              )}
            </>
          )}

          {pointsAwarded && pointsAwarded.length > 0 && (
            <div className="bg-gray-800 rounded-xl p-4 flex flex-col gap-2 text-left">
              <p className="text-sm font-semibold text-gray-400 text-center">Points earned this round</p>
              {pointsAwarded.map(award => (
                <div
                  key={award.playerId}
                  className={`flex justify-between items-center text-sm rounded-lg px-3 py-1.5 ${award.playerId === playerId ? 'bg-amber-400/20 text-amber-300' : 'text-gray-300'}`}
                >
                  <span>{award.username}{award.playerId === playerId ? ' (you)' : ''}</span>
                  <span className="font-bold">{award.pointsEarned > 0 ? `+${award.pointsEarned}` : '—'}</span>
                </div>
              ))}
            </div>
          )}

          <button onClick={() => getSocket().emit('game:returnToLobby', { gameId })} className="bg-amber-400 hover:bg-amber-300 text-gray-950 font-semibold rounded-lg py-3 transition">
            Return to Lobby
          </button>
        </div>
      )}
    </div>
  );
}
