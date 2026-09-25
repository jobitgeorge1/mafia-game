# 🎭 Mafia — The Web Game

A real-time, web-based multiplayer Mafia game for 4–12 players built with Node.js, Express, and Socket.io.

---

## Features

- **4–12 players** in a single room
- **4 roles**: Mafia, Detective, Doctor, Villager
- **Full game loop**: Night → Day Reveal → Discussion → Vote → repeat
- **Real-time** via WebSockets (Socket.io)
- **Role-reveal modal** on game start
- **Night actions** per role (kill, save, investigate)
- **Live vote tally** during day voting
- **Phase countdown timer** (SVG ring)
- **Mafia team chat** during night
- **Dead player ghost chat**
- **Reconnection support** — session stored in localStorage; rejoining restores your state
- **Event log** — full game history drawer
- **Responsive** — works on desktop and mobile

---

## Quick Start

### Prerequisites
- Node.js 16+
- npm

### Install & Run

```bash
cd mafia-game
npm install
npm start
```

Open **http://localhost:3000** in multiple browser tabs (or on different devices on the same network).

### Development (auto-restart)

```bash
npm run dev
```

---

## Game Rules

### Roles

| Role | Team | Night Action |
|------|------|-------------|
| 🔫 Mafia | Mafia | Vote to eliminate one player |
| 🔍 Detective | Village | Investigate one player (learn if Mafia) |
| 💉 Doctor | Village | Protect one player (self-save limited to once) |
| 🏘️ Villager | Village | None — vote during the day |

### Role Counts

| Players | Mafia | Detective | Doctor | Villagers |
|---------|-------|-----------|--------|-----------|
| 4–5     | 1     | 1         | 1      | 1–2       |
| 6–8     | 2     | 1         | 1      | 2–4       |
| 9–12    | 3     | 1         | 1      | 4–7       |

### Win Conditions

- **Village wins** — all Mafia members are eliminated
- **Mafia wins** — Mafia count equals or exceeds village count

### Phase Timers

| Phase | Duration |
|-------|----------|
| Night | 30 seconds |
| Day Reveal | 5 seconds |
| Discussion | 90 seconds |
| Vote | 40 seconds |
| Vote Result | 5 seconds |

---

## Project Structure

```
mafia-game/
├── server/
│   ├── index.js          # Express + Socket.io entry point
│   ├── gameEngine.js     # Core state machine (phases, actions, win conditions)
│   ├── roles.js          # Role definitions and assignment
│   ├── roomManager.js    # Room lifecycle and broadcasting
│   └── socketHandlers.js # All Socket.io event handlers
├── public/
│   ├── index.html        # Single-page app shell
│   ├── css/main.css      # Dark noir theme
│   └── js/client.js      # Frontend logic (socket client, UI rendering)
├── package.json
└── README.md
```

---

## Deployment

Set the `PORT` environment variable to run on a different port:

```bash
PORT=8080 npm start
```

The health check endpoint is available at `/health`.
