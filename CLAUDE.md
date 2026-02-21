# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Chessus** is a 2v2 chess game with an "Among Us"-style twist. Four players join a lobby, are assigned to teams (seats 0-3), and one player per team is secretly designated as an "imposter." Players take turns making chess moves in seat order (0→1→2→3), and can vote to identify imposters.

## Commands

### Development (from repo root)
```bash
npm run dev    # Start both backend (port 3001) and frontend (port 5173) concurrently
npm run build  # Build both backend and frontend
```

### Backend (from `backend/`)
```bash
npm run start:dev   # Watch mode with hot reload
npm run build       # Compile TypeScript → dist/
npm run test        # Run unit tests (Jest)
npm run test:watch  # Tests in watch mode
npm run test:cov    # Tests with coverage
npm run lint        # ESLint with auto-fix
npm run format      # Prettier format
```

### Frontend (from `frontend/`)
```bash
npm run dev      # Vite dev server on port 5173
npm run build    # tsc -b && vite build
npm run lint     # ESLint
npm run preview  # Preview production build
```

## Architecture

### Tech Stack
- **Backend**: NestJS 11, Prisma 5 + PostgreSQL, Socket.IO 4
- **Frontend**: React 19, Vite 7, Zustand (state), React Router 7, chess.js + react-chessboard, Tailwind CSS 4, Socket.IO Client 4

### Communication Pattern
All client-server communication is via **Socket.IO WebSockets only** — there are no REST HTTP endpoints for game logic. Gateways handle socket events, delegate to services for business logic, then broadcast results to clients.

### Backend Module Structure
```
AppModule
├── PrismaModule (global) — database singleton
├── LobbyModule — pre-game lobby management
│   ├── LobbyGateway — socket events (lobby:create, lobby:join, lobby:leave, lobby:changeTeam, lobby:kick, lobby:start)
│   └── LobbyService — lobby/player CRUD, seat/imposter assignment
└── GameModule — active chess gameplay
    ├── GameGateway — socket events (game:start, game:requestState, game:move, game:vote, game:endGame)
    └── GameService — move validation, voting, win conditions
```

### Database Schema (Prisma)
- **Lobby**: 4 players max, unique join code
- **Player**: belongs to Lobby, has `team` (A/B), `seat` (0-3), `isImposter` bool, `socketId`
- **Game**: one-to-one with Lobby, tracks FEN, current turn, voting phase
- **Move**: algebraic notation + FEN per move
- **Vote**: voting records per game

### Seat/Turn Logic
- Seats 0 and 2 → Team A (White)
- Seats 1 and 3 → Team B (Black)
- Turn order: seat 0 → 1 → 2 → 3 → 0...
- Even turns = White moves, Odd turns = Black moves

### Frontend State Management
`gameStore.ts` (Zustand) is the single source of truth:
- `playerId`, `username` — player identity
- `lobby` — current lobby state (LobbyDto)
- `game` — current game state (GameState)
- `myRole` — this player's team/seat/imposter status
- `voteResult` — resolved after voting phase

### Socket Client
`frontend/src/lib/socket.ts` exports a singleton Socket.IO client. Use `getSocket()` to access the existing connection and `connectSocket()` to initialize it. All pages attach/detach socket listeners in `useEffect`.

### Shared Types
- Backend shared types: `backend/src/shared/types.ts`
- Frontend types: `frontend/src/types/index.ts`
- Keep these in sync — they define the socket event payloads

## Environment

**Backend** (`backend/.env`):
```
DATABASE_URL="postgresql://postgres:admin@localhost:5432/chessus?schema=public"
```

**Frontend** (`frontend/.env`):
```
VITE_BACKEND_URL=http://localhost:3001
```

PostgreSQL must be running locally before starting the backend. After schema changes, run `npx prisma migrate dev` from `backend/`.
