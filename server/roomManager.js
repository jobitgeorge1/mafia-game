/**
 * RoomManager — manages the lifecycle of all active game rooms.
 *
 * Handles:
 *   - Room creation and cleanup
 *   - Player-to-room mapping (for reconnection)
 *   - Room code generation
 */

const { GameEngine } = require('./gameEngine');

// Room code is 6 uppercase alphanumeric characters
const CODE_LENGTH = 6;
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // Unambiguous chars (no O/0, 1/I)

// Max idle time before a lobby is cleaned up (15 minutes)
const LOBBY_TTL_MS = 15 * 60 * 1000;

// Max idle time after game ends before room is cleaned up (5 minutes)
const GAMEOVER_TTL_MS = 5 * 60 * 1000;

class RoomManager {
  constructor(io) {
    this.io = io;
    // roomCode → GameEngine
    this.rooms = new Map();
    // playerId → roomCode  (for reconnection lookup)
    this.playerRoomMap = new Map();
    // roomCode → cleanup timer
    this.cleanupTimers = new Map();

    // Sweep stale rooms every 5 minutes
    setInterval(() => this._sweepStaleRooms(), 5 * 60 * 1000);
  }

  // ─────────────────────────────────────────────
  // ROOM CREATION & LOOKUP
  // ─────────────────────────────────────────────

  createRoom() {
    const code = this._generateUniqueCode();
    const engine = new GameEngine(code, (eventName, data) => {
      this._broadcastEvent(code, eventName, data);
    });

    this.rooms.set(code, engine);
    this._scheduleCleanup(code, LOBBY_TTL_MS);
    return code;
  }

  getRoom(roomCode) {
    return this.rooms.get(roomCode.toUpperCase()) || null;
  }

  roomExists(roomCode) {
    return this.rooms.has(roomCode.toUpperCase());
  }

  deleteRoom(roomCode) {
    const engine = this.rooms.get(roomCode);
    if (engine) {
      engine.destroy();
      this.rooms.delete(roomCode);
    }
    const timer = this.cleanupTimers.get(roomCode);
    if (timer) {
      clearTimeout(timer);
      this.cleanupTimers.delete(roomCode);
    }
  }

  // ─────────────────────────────────────────────
  // PLAYER ↔ ROOM MAPPING
  // ─────────────────────────────────────────────

  trackPlayer(playerId, roomCode) {
    this.playerRoomMap.set(playerId, roomCode);
  }

  untrackPlayer(playerId) {
    this.playerRoomMap.delete(playerId);
  }

  getRoomForPlayer(playerId) {
    return this.playerRoomMap.get(playerId) || null;
  }

  // ─────────────────────────────────────────────
  // BROADCASTING
  // ─────────────────────────────────────────────

  /**
   * Broadcast an event to all clients in a room.
   * Some events (like detective_result) are sent to a single socket.
   */
  _broadcastEvent(roomCode, eventName, data) {
    if (eventName === 'detective_result') {
      // Private — send only to the detective's socket
      if (data.socketId) {
        this.io.to(data.socketId).emit('detective_result', {
          targetName: data.targetName,
          isMafia: data.isMafia,
        });
      }
      return;
    }

    this.io.to(roomCode).emit(eventName, data);
  }

  // ─────────────────────────────────────────────
  // CLEANUP
  // ─────────────────────────────────────────────

  _scheduleCleanup(roomCode, delay) {
    const existing = this.cleanupTimers.get(roomCode);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      const room = this.rooms.get(roomCode);
      if (room) {
        console.log(`[RoomManager] Cleaning up stale room: ${roomCode}`);
        this.io.to(roomCode).emit('room_closed', { reason: 'Room expired due to inactivity.' });
        this.deleteRoom(roomCode);
      }
    }, delay);

    this.cleanupTimers.set(roomCode, timer);
  }

  rescheduleCleanup(roomCode) {
    // Called when a game ends — give players time to read results
    this._scheduleCleanup(roomCode, GAMEOVER_TTL_MS);
  }

  _sweepStaleRooms() {
    for (const [code, engine] of this.rooms) {
      const connectedCount = engine.getConnectedPlayers().length;
      if (connectedCount === 0) {
        console.log(`[RoomManager] Sweeping empty room: ${code}`);
        this.deleteRoom(code);
      }
    }
  }

  // ─────────────────────────────────────────────
  // UTILITIES
  // ─────────────────────────────────────────────

  _generateUniqueCode(extraRooms) {
    // extraRooms: optional Set/Map of additional codes to avoid (e.g. UC rooms)
    let code;
    do {
      code = Array.from({ length: CODE_LENGTH }, () =>
        CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]
      ).join('');
    } while (this.rooms.has(code) || extraRooms?.has(code));
    return code;
  }

  getStats() {
    return {
      activeRooms: this.rooms.size,
      trackedPlayers: this.playerRoomMap.size,
    };
  }
}

module.exports = { RoomManager };
