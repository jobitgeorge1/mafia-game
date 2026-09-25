/**
 * socketHandlers.js — Wires all Socket.io events to the game engine.
 *
 * Client → Server events:
 *   create_room      { playerName }
 *   join_room        { roomCode, playerName, playerId? }
 *   start_game       { roomCode }
 *   night_action     { roomCode, targetId }
 *   day_vote         { roomCode, targetId }  (targetId = 'skip' to skip)
 *   request_state    { roomCode }
 *   send_chat        { roomCode, message }
 *   leave_room       { roomCode }
 *
 * Server → Client events:
 *   room_created      { roomCode, playerId, playerName }
 *   room_joined       { roomCode, playerId, playerName, state }
 *   lobby_update      { players, hostId, playerCount, roomCode }
 *   game_started      { state }            — full state snapshot per player
 *   phase_change      { phase, round, phaseEndTime, alivePlayers }
 *   night_result      { killedPlayer, savedByDoctor, round }
 *   detective_result  { targetName, isMafia }    — only to detective
 *   vote_update       { tally, skipCount, totalVoted, totalAlive }
 *   vote_result       { eliminated, tie, skipped, message }
 *   game_over         { winningTeam, message, players, log }
 *   state_snapshot    { state }            — on reconnect / request
 *   chat_message      { senderName, message, timestamp }
 *   player_left       { playerName, playerId }
 *   error             { message }
 *   room_closed       { reason }
 */

const { v4: uuidv4 } = require('uuid');
const { PHASES } = require('./gameEngine');

const MAX_CHAT_LENGTH = 200;
const CHAT_RATE_LIMIT_MS = 500; // min ms between messages per player

function registerHandlers(io, roomManager) {

  io.on('connection', (socket) => {
    console.log(`[Socket] Connected: ${socket.id}`);

    // Track last chat time for rate limiting
    socket.lastChatTime = 0;

    // ─────────────────────────────────────────────
    // CREATE ROOM
    // ─────────────────────────────────────────────
    socket.on('create_room', ({ playerName } = {}) => {
      try {
        const name = sanitizeName(playerName);
        if (!name) return socket.emit('error', { message: 'Please enter a valid name (1–20 characters).' });

        const roomCode = roomManager.createRoom();
        const playerId = uuidv4();
        const room = roomManager.getRoom(roomCode);

        const result = room.addPlayer(playerId, name, socket.id);
        if (!result.success) {
          roomManager.deleteRoom(roomCode);
          return socket.emit('error', { message: result.error });
        }

        socket.join(roomCode);
        socket.playerId = playerId;
        socket.roomCode = roomCode;
        roomManager.trackPlayer(playerId, roomCode);

        socket.emit('room_created', {
          roomCode,
          playerId,
          playerName: name,
        });

        broadcastLobbyUpdate(io, room, roomCode);
        console.log(`[Room] Created: ${roomCode} by ${name} (${playerId})`);
      } catch (err) {
        console.error('[create_room error]', err);
        socket.emit('error', { message: 'Failed to create room. Please try again.' });
      }
    });

    // ─────────────────────────────────────────────
    // JOIN ROOM
    // ─────────────────────────────────────────────
    socket.on('join_room', ({ roomCode, playerName, playerId: existingPlayerId } = {}) => {
      try {
        const name = sanitizeName(playerName);
        if (!name) return socket.emit('error', { message: 'Please enter a valid name (1–20 characters).' });

        const code = (roomCode || '').toUpperCase().trim();
        if (!code || code.length !== 6) {
          return socket.emit('error', { message: 'Invalid room code.' });
        }

        const room = roomManager.getRoom(code);
        if (!room) return socket.emit('error', { message: 'Room not found. Check the code and try again.' });

        // Handle reconnection attempt
        if (existingPlayerId) {
          const reconnResult = room.reconnectPlayer(existingPlayerId, socket.id);
          if (reconnResult.success) {
            socket.join(code);
            socket.playerId = existingPlayerId;
            socket.roomCode = code;
            room.updateSocketId(existingPlayerId, socket.id);
            roomManager.trackPlayer(existingPlayerId, code);

            const state = room.getStateForPlayer(existingPlayerId);
            socket.emit('state_snapshot', { state });
            broadcastLobbyUpdate(io, room, code);
            console.log(`[Room] Reconnected: ${existingPlayerId} to ${code}`);
            return;
          }
        }

        // Fresh join
        const playerId = uuidv4();
        const result = room.addPlayer(playerId, name, socket.id);
        if (!result.success) return socket.emit('error', { message: result.error });

        socket.join(code);
        socket.playerId = playerId;
        socket.roomCode = code;
        roomManager.trackPlayer(playerId, code);

        const state = room.getLobbyState();
        socket.emit('room_joined', {
          roomCode: code,
          playerId,
          playerName: name,
          isHost: result.isHost,
          state,
        });

        broadcastLobbyUpdate(io, room, code);
        console.log(`[Room] Joined: ${name} (${playerId}) → ${code}`);
      } catch (err) {
        console.error('[join_room error]', err);
        socket.emit('error', { message: 'Failed to join room. Please try again.' });
      }
    });

    // ─────────────────────────────────────────────
    // START GAME
    // ─────────────────────────────────────────────
    socket.on('start_game', ({ roomCode } = {}) => {
      try {
        const room = getSocketRoom(socket, roomCode, roomManager);
        if (!room) return;

        const result = room.startGame(socket.playerId);
        if (!result.success) return socket.emit('error', { message: result.error });

        // Send each player their personalised state snapshot
        for (const player of room.players.values()) {
          if (player.connected && player.socketId) {
            const state = room.getStateForPlayer(player.id);
            io.to(player.socketId).emit('game_started', { state });
          }
        }

        console.log(`[Room] Game started: ${roomCode}`);
      } catch (err) {
        console.error('[start_game error]', err);
        socket.emit('error', { message: 'Failed to start game.' });
      }
    });

    // ─────────────────────────────────────────────
    // NIGHT ACTION
    // ─────────────────────────────────────────────
    socket.on('night_action', ({ roomCode, targetId } = {}) => {
      try {
        const room = getSocketRoom(socket, roomCode, roomManager);
        if (!room) return;

        const result = room.submitNightAction(socket.playerId, targetId);
        if (!result.success) return socket.emit('error', { message: result.error });

        // Acknowledge to the actor
        socket.emit('action_confirmed', { message: 'Your action has been submitted.' });

        // For mafia: broadcast to other mafia that someone voted
        const player = room.players.get(socket.playerId);
        if (player?.role === 'mafia') {
          broadcastToMafia(io, room, 'mafia_vote_update', {
            voterId: socket.playerId,
            voterName: player.name,
            targetId,
            targetName: room.players.get(targetId)?.name,
          });
        }
      } catch (err) {
        console.error('[night_action error]', err);
        socket.emit('error', { message: 'Failed to submit night action.' });
      }
    });

    // ─────────────────────────────────────────────
    // DAY VOTE
    // ─────────────────────────────────────────────
    socket.on('day_vote', ({ roomCode, targetId } = {}) => {
      try {
        const room = getSocketRoom(socket, roomCode, roomManager);
        if (!room) return;

        const result = room.submitDayVote(socket.playerId, targetId);
        if (!result.success) return socket.emit('error', { message: result.error });

        socket.emit('action_confirmed', { message: 'Vote submitted.' });
      } catch (err) {
        console.error('[day_vote error]', err);
        socket.emit('error', { message: 'Failed to submit vote.' });
      }
    });

    // ─────────────────────────────────────────────
    // CHAT
    // ─────────────────────────────────────────────
    socket.on('send_chat', ({ roomCode, message } = {}) => {
      try {
        const room = getSocketRoom(socket, roomCode, roomManager);
        if (!room) return;

        const now = Date.now();
        if (now - socket.lastChatTime < CHAT_RATE_LIMIT_MS) {
          return socket.emit('error', { message: 'You are sending messages too quickly.' });
        }
        socket.lastChatTime = now;

        const player = room.players.get(socket.playerId);
        if (!player) return;

        // During night phase, only mafia can chat (with each other), 
        // and dead players are silenced
        if (room.phase === PHASES.NIGHT) {
          if (!player.alive) return socket.emit('error', { message: 'The dead cannot speak.' });
          if (player.role !== 'mafia') {
            return socket.emit('error', { message: 'You cannot chat during the night.' });
          }
          // Mafia-only chat during night
          const msg = sanitizeMessage(message);
          if (!msg) return;
          broadcastToMafia(io, room, 'chat_message', {
            senderName: player.name,
            message: msg,
            timestamp: now,
            isMafiaChat: true,
          });
          return;
        }

        // Dead players can only "whisper" — shown differently
        const msg = sanitizeMessage(message);
        if (!msg) return;

        if (!player.alive) {
          // Dead chat is shown only to other dead players + spectators
          broadcastToDead(io, room, 'chat_message', {
            senderName: `👻 ${player.name}`,
            message: msg,
            timestamp: now,
            isDeadChat: true,
          });
          return;
        }

        io.to(roomCode).emit('chat_message', {
          senderName: player.name,
          message: msg,
          timestamp: now,
        });
      } catch (err) {
        console.error('[send_chat error]', err);
      }
    });

    // ─────────────────────────────────────────────
    // REQUEST STATE SNAPSHOT
    // ─────────────────────────────────────────────
    socket.on('request_state', ({ roomCode } = {}) => {
      try {
        const room = getSocketRoom(socket, roomCode, roomManager);
        if (!room) return;

        const state = room.phase === PHASES.LOBBY
          ? room.getLobbyState()
          : room.getStateForPlayer(socket.playerId);

        socket.emit('state_snapshot', { state });
      } catch (err) {
        console.error('[request_state error]', err);
        socket.emit('error', { message: 'Could not retrieve game state.' });
      }
    });

    // ─────────────────────────────────────────────
    // LEAVE ROOM
    // ─────────────────────────────────────────────
    socket.on('leave_room', ({ roomCode } = {}) => {
      handlePlayerLeave(socket, roomCode || socket.roomCode, io, roomManager);
    });

    // ─────────────────────────────────────────────
    // DISCONNECT
    // ─────────────────────────────────────────────
    socket.on('disconnect', (reason) => {
      console.log(`[Socket] Disconnected: ${socket.id} (${reason})`);
      handlePlayerLeave(socket, socket.roomCode, io, roomManager, true);
    });

  });
}

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────

function handlePlayerLeave(socket, roomCode, io, roomManager, isDisconnect = false) {
  if (!roomCode || !socket.playerId) return;

  const room = roomManager.getRoom(roomCode);
  if (!room) return;

  const player = room.players.get(socket.playerId);
  const playerName = player?.name || 'A player';

  room.removePlayer(socket.playerId);
  roomManager.untrackPlayer(socket.playerId);
  socket.leave(roomCode);

  if (room.phase === PHASES.LOBBY) {
    // If room is now empty, delete it
    if (room.getPlayerCount() === 0) {
      roomManager.deleteRoom(roomCode);
      return;
    }
    broadcastLobbyUpdate(io, room, roomCode);
  }

  io.to(roomCode).emit('player_left', {
    playerId: socket.playerId,
    playerName,
    isDisconnect,
  });

  // If game is over after player leaves, reschedule cleanup
  if (room.phase === PHASES.GAME_OVER) {
    roomManager.rescheduleCleanup(roomCode);
  }
}

function getSocketRoom(socket, roomCode, roomManager) {
  const code = (roomCode || socket.roomCode || '').toUpperCase().trim();
  const room = roomManager.getRoom(code);
  if (!room) {
    socket.emit('error', { message: 'Room not found.' });
    return null;
  }
  return room;
}

function broadcastLobbyUpdate(io, room, roomCode) {
  const state = room.getLobbyState();
  io.to(roomCode).emit('lobby_update', state);
}

function broadcastToMafia(io, room, eventName, data) {
  for (const player of room.players.values()) {
    if (player.role === 'mafia' && player.connected && player.socketId) {
      io.to(player.socketId).emit(eventName, data);
    }
  }
}

function broadcastToDead(io, room, eventName, data) {
  for (const player of room.players.values()) {
    if (!player.alive && player.connected && player.socketId) {
      io.to(player.socketId).emit(eventName, data);
    }
  }
}

function sanitizeName(name) {
  if (typeof name !== 'string') return '';
  return name.trim().replace(/[<>]/g, '').slice(0, 20);
}

function sanitizeMessage(message) {
  if (typeof message !== 'string') return '';
  return message.trim().replace(/[<>]/g, '').slice(0, MAX_CHAT_LENGTH);
}

module.exports = { registerHandlers };
