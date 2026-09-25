/**
 * Game Night Server — Entry point
 *
 * Hosts two games on the same server:
 *   🎭 Mafia      — social deduction / elimination
 *   🕵️ Undercover — word deduction / imposter
 *
 * Stack: Express + Socket.io
 */

const express = require('express');
const http    = require('http');
const path    = require('path');
const { Server } = require('socket.io');
const { RoomManager }               = require('./roomManager');
const { registerHandlers }          = require('./socketHandlers');
const { registerUndercoverHandlers } = require('./undercoverHandlers');

const PORT = process.env.PORT || 3000;

const app = express();
const server = http.createServer(app);

// Socket.io setup with sensible defaults
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
  // Reconnection & ping settings
  pingInterval: 10000,
  pingTimeout: 5000,
  // Allow transport fallback
  transports: ['websocket', 'polling'],
});

// ─────────────────────────────────────────────
// STATIC FILES
// ─────────────────────────────────────────────
app.use(express.static(path.join(__dirname, '..', 'public')));

// Health check endpoint (useful for deployments)
app.get('/health', (_req, res) => {
  res.json({
    status:  'ok',
    mafia:   roomManager?.getStats?.() || {},
    uptime:  process.uptime(),
  });
});

// Catch-all: serve the SPA
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// ─────────────────────────────────────────────
// GAME LAYER — both games share one RoomManager
// ─────────────────────────────────────────────
const roomManager = new RoomManager(io);
registerHandlers(io, roomManager);            // 🎭 Mafia
registerUndercoverHandlers(io, roomManager);  // 🕵️ Undercover

// ─────────────────────────────────────────────
// START SERVER
// ─────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`\n🎮  Game Night Server running at http://localhost:${PORT}`);
  console.log(`    🎭  Mafia game ready`);
  console.log(`    🕵️   Undercover game ready\n`);
});

// ─────────────────────────────────────────────
// GRACEFUL SHUTDOWN
// ─────────────────────────────────────────────
function shutdown(signal) {
  console.log(`\n[Server] ${signal} received. Shutting down gracefully...`);
  io.emit('room_closed', { reason: 'Server is shutting down.' });
  server.close(() => {
    console.log('[Server] HTTP server closed.');
    process.exit(0);
  });
  // Force exit after 5s if close hangs
  setTimeout(() => process.exit(1), 5000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('uncaughtException', (err) => {
  console.error('[Server] Uncaught exception:', err);
});

process.on('unhandledRejection', (reason) => {
  console.error('[Server] Unhandled rejection:', reason);
});
