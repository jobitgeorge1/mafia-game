/**
 * undercoverHandlers.js — Socket.io event handlers for the Undercover game.
 *
 * All client→server events are prefixed "uc_" to avoid any collision with Mafia events.
 *
 * Client → Server events:
 *   uc_create_room      { playerName }
 *   uc_join_room        { roomCode, playerName, playerId? }
 *   uc_update_settings  { roomCode, settings }
 *   uc_start_game       { roomCode }
 *   uc_submit_clue      { roomCode, clue }
 *   uc_skip_clue        { roomCode }
 *   uc_host_advance     { roomCode }           — host forces next clue turn
 *   uc_host_start_vote  { roomCode }           — host skips discussion to vote
 *   uc_submit_vote      { roomCode, targetId } — targetId='skip' to pass
 *   uc_submit_guess     { roomCode, guess }    — blank/undercover word guess
 *   uc_request_state    { roomCode }
 *   uc_send_chat        { roomCode, message }
 *   uc_leave_room       { roomCode }
 *
 * Server → Client events:
 *   uc_room_created       { roomCode, playerId, playerName }
 *   uc_room_joined        { roomCode, playerId, playerName, isHost, state }
 *   uc_lobby_update       { ...lobbyState }
 *   uc_settings_updated   { settings }
 *   uc_game_started       { state }             — individualised per player
 *   uc_word_reveal        { myWord, myRole, myRoleMeta, categoryLabel? }  — private
 *   uc_phase_change       { phase, round, phaseEndTime, alivePlayers, clues, currentClueTurnId }
 *   uc_clue_turn          { currentPlayerId, currentPlayerName, clues, clueEndTime, ... }
 *   uc_clue_submitted     { entry, clues }
 *   uc_vote_update        { tally, skipCount, totalVoted, totalAlive }
 *   uc_vote_result        { eliminated, isTie, skipped, message }
 *   uc_blank_guess_prompt { playerId, playerName, socketId, deadline }  — private to blank
 *   uc_undercover_guess_prompt { ... }                                  — private to undercover
 *   uc_guess_result       { playerId, playerName, guess, correct, civilianWord, isUndercover }
 *   uc_game_over          { winningTeam, message, players, wordA, wordB, categoryLabel, log }
 *   uc_state_snapshot     { state }
 *   uc_chat_message       { senderName, message, timestamp }
 *   uc_player_left        { playerId, playerName, isDisconnect }
 *   uc_action_confirmed   { message }
 *   uc_error              { message }
 *   uc_room_closed        { reason }
 */

const { v4: uuidv4 }       = require('uuid');
const { UndercoverEngine, UC_PHASES } = require('./undercoverEngine');
const { getCategoryList }  = require('./wordPacks');

const CHAT_RATE_LIMIT_MS = 500;
const MAX_CHAT_LENGTH    = 200;

// ─────────────────────────────────────────────
// ROOM MANAGER EXTENSION
// We reuse the existing RoomManager but store undercover rooms
// in a separate Map keyed on the same RoomManager instance.
// ─────────────────────────────────────────────

/** Weak side-table: roomManager instance → { ucRooms: Map, ucPlayerMap: Map } */
const ucStore = new WeakMap();

function getUcStore(roomManager) {
  if (!ucStore.has(roomManager)) {
    ucStore.set(roomManager, {
      ucRooms:     new Map(),   // roomCode → UndercoverEngine
      ucPlayerMap: new Map(),   // playerId → roomCode
    });
  }
  return ucStore.get(roomManager);
}

function createUcRoom(io, roomManager) {
  const store = getUcStore(roomManager);
  // Pass UC rooms map so code is unique across BOTH game types
  const code  = roomManager._generateUniqueCode
    ? roomManager._generateUniqueCode(store.ucRooms)
    : _genCode(store.ucRooms, roomManager.rooms);

  const engine = new UndercoverEngine(code, (eventName, data) => {
    broadcastUcEvent(io, store, code, eventName, data);
  });

  store.ucRooms.set(code, engine);

  // Auto-cleanup after 15 minutes of lobby idle
  scheduleUcCleanup(io, store, code, 15 * 60 * 1000);
  return code;
}

function getUcRoom(store, roomCode) {
  return store.ucRooms.get((roomCode || '').toUpperCase()) || null;
}

function deleteUcRoom(store, roomCode) {
  const engine = store.ucRooms.get(roomCode);
  if (engine) { engine.destroy(); store.ucRooms.delete(roomCode); }
}

function scheduleUcCleanup(io, store, roomCode, delayMs) {
  // Use engine's eventLog to piggyback a cleanup timer without a separate map
  const engine = store.ucRooms.get(roomCode);
  if (!engine) return;
  if (engine._cleanupTimer) clearTimeout(engine._cleanupTimer);
  engine._cleanupTimer = setTimeout(() => {
    const e = store.ucRooms.get(roomCode);
    if (e) {
      io.to(roomCode).emit('uc_room_closed', { reason: 'Room expired due to inactivity.' });
      deleteUcRoom(store, roomCode);
    }
  }, delayMs);
}

/** Generate a unique 6-char room code avoiding collisions with both game types */
function _genCode(ucRooms, mafiaRooms) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (ucRooms.has(code) || mafiaRooms.has(code));
  return code;
}

// ─────────────────────────────────────────────
// BROADCAST
// ─────────────────────────────────────────────

function broadcastUcEvent(io, store, roomCode, eventName, data) {
  // Private events: routed to a single socket
  if (
    eventName === 'uc_blank_guess_prompt' ||
    eventName === 'uc_undercover_guess_prompt'
  ) {
    if (data.socketId) {
      // Send full prompt to the guesser
      io.to(data.socketId).emit(eventName, {
        playerId:   data.playerId,
        playerName: data.playerName,
        deadline:   data.deadline,
        isUndercover: data.isUndercover || false,
      });
    }
    // Also broadcast to room (without socketId) so everyone sees the phase
    io.to(roomCode).emit('uc_phase_change', {
      phase:       UC_PHASES.BLANK_GUESS,
      guesserName: data.playerName,
      isUndercover: data.isUndercover || false,
    });
    return;
  }

  // Word reveal: private per player — handled in game_started flow, not here
  // Everything else: broadcast to room
  io.to(roomCode).emit(eventName, data);
}

// ─────────────────────────────────────────────
// HANDLER REGISTRATION
// ─────────────────────────────────────────────

function registerUndercoverHandlers(io, roomManager) {
  io.on('connection', (socket) => {

    // ── CREATE ROOM ──────────────────────────────────────────
    socket.on('uc_create_room', ({ playerName } = {}) => {
      try {
        const name = sanitizeName(playerName);
        if (!name) return socket.emit('uc_error', { message: 'Enter a valid name (1–20 chars).' });

        const store   = getUcStore(roomManager);
        const code    = createUcRoom(io, roomManager);
        const engine  = getUcRoom(store, code);
        const playerId = uuidv4();

        const result = engine.addPlayer(playerId, name, socket.id);
        if (!result.success) {
          deleteUcRoom(store, code);
          return socket.emit('uc_error', { message: result.error });
        }

        socket.join(code);
        socket.ucPlayerId  = playerId;
        socket.ucRoomCode  = code;
        store.ucPlayerMap.set(playerId, code);

        socket.emit('uc_room_created', {
          roomCode:   code,
          playerId,
          playerName: name,
          categories: getCategoryList(),
        });

        broadcastUcLobbyUpdate(io, engine, code);
        console.log(`[UC] Room created: ${code} by ${name}`);
      } catch (err) {
        console.error('[uc_create_room]', err);
        socket.emit('uc_error', { message: 'Failed to create room.' });
      }
    });

    // ── JOIN ROOM ─────────────────────────────────────────────
    socket.on('uc_join_room', ({ roomCode, playerName, playerId: existingId } = {}) => {
      try {
        const name = sanitizeName(playerName);
        if (!name) return socket.emit('uc_error', { message: 'Enter a valid name (1–20 chars).' });

        const code  = (roomCode || '').toUpperCase().trim();
        if (!code || code.length !== 6) {
          return socket.emit('uc_error', { message: 'Invalid room code.' });
        }

        const store  = getUcStore(roomManager);
        const engine = getUcRoom(store, code);
        if (!engine) return socket.emit('uc_error', { message: 'Room not found. Check the code.' });

        // Reconnect path
        if (existingId) {
          const reconn = engine.reconnectPlayer(existingId, socket.id);
          if (reconn.success) {
            socket.join(code);
            socket.ucPlayerId = existingId;
            socket.ucRoomCode = code;
            engine.updateSocketId(existingId, socket.id);
            store.ucPlayerMap.set(existingId, code);

            const state = engine.phase === UC_PHASES.LOBBY
              ? engine.getLobbyState()
              : engine.getStateForPlayer(existingId);
            socket.emit('uc_state_snapshot', { state });
            broadcastUcLobbyUpdate(io, engine, code);
            console.log(`[UC] Reconnected: ${existingId} → ${code}`);
            return;
          }
        }

        // Fresh join
        const playerId = uuidv4();
        const result = engine.addPlayer(playerId, name, socket.id);
        if (!result.success) return socket.emit('uc_error', { message: result.error });

        socket.join(code);
        socket.ucPlayerId = playerId;
        socket.ucRoomCode = code;
        store.ucPlayerMap.set(playerId, code);

        socket.emit('uc_room_joined', {
          roomCode:   code,
          playerId,
          playerName: name,
          isHost:     result.isHost,
          state:      engine.getLobbyState(),
          categories: getCategoryList(),
        });

        broadcastUcLobbyUpdate(io, engine, code);
        console.log(`[UC] Joined: ${name} → ${code}`);
      } catch (err) {
        console.error('[uc_join_room]', err);
        socket.emit('uc_error', { message: 'Failed to join room.' });
      }
    });

    // ── UPDATE SETTINGS ───────────────────────────────────────
    socket.on('uc_update_settings', ({ roomCode, settings } = {}) => {
      try {
        const engine = getUcEngineForSocket(socket, roomCode, roomManager);
        if (!engine) return;

        const result = engine.updateSettings(socket.ucPlayerId, settings || {});
        if (!result.success) return socket.emit('uc_error', { message: result.error });

        // Broadcast updated settings to whole room
        io.to(engine.roomCode).emit('uc_settings_updated', {
          settings: result.settings,
        });
        broadcastUcLobbyUpdate(io, engine, engine.roomCode);
      } catch (err) {
        console.error('[uc_update_settings]', err);
        socket.emit('uc_error', { message: 'Failed to update settings.' });
      }
    });

    // ── START GAME ────────────────────────────────────────────
    socket.on('uc_start_game', ({ roomCode } = {}) => {
      try {
        const engine = getUcEngineForSocket(socket, roomCode, roomManager);
        if (!engine) return;

        const result = engine.startGame(socket.ucPlayerId);
        if (!result.success) return socket.emit('uc_error', { message: result.error });

        // Send each player their private word reveal
        for (const player of engine.players.values()) {
          if (player.connected && player.socketId) {
            const state = engine.getStateForPlayer(player.id);
            // game_started carries the full personalised state
            io.to(player.socketId).emit('uc_game_started', { state });
          }
        }

        console.log(`[UC] Game started: ${engine.roomCode}`);
      } catch (err) {
        console.error('[uc_start_game]', err);
        socket.emit('uc_error', { message: 'Failed to start game.' });
      }
    });

    // ── SUBMIT CLUE ───────────────────────────────────────────
    socket.on('uc_submit_clue', ({ roomCode, clue } = {}) => {
      try {
        const engine = getUcEngineForSocket(socket, roomCode, roomManager);
        if (!engine) return;

        const sanitized = sanitizeMessage(clue);
        if (!sanitized && !engine.settings.allowSkipClue) {
          return socket.emit('uc_error', { message: 'Clue cannot be empty.' });
        }

        const result = engine.submitClue(socket.ucPlayerId, sanitized);
        if (!result.success) return socket.emit('uc_error', { message: result.error });

        socket.emit('uc_action_confirmed', { message: 'Clue submitted.' });
      } catch (err) {
        console.error('[uc_submit_clue]', err);
        socket.emit('uc_error', { message: 'Failed to submit clue.' });
      }
    });

    // ── SKIP CLUE ─────────────────────────────────────────────
    socket.on('uc_skip_clue', ({ roomCode } = {}) => {
      try {
        const engine = getUcEngineForSocket(socket, roomCode, roomManager);
        if (!engine) return;

        const result = engine.skipClue(socket.ucPlayerId);
        if (!result.success) return socket.emit('uc_error', { message: result.error });

        socket.emit('uc_action_confirmed', { message: 'Clue skipped.' });
      } catch (err) {
        console.error('[uc_skip_clue]', err);
        socket.emit('uc_error', { message: 'Failed to skip clue.' });
      }
    });

    // ── HOST ADVANCE (force next clue) ────────────────────────
    socket.on('uc_host_advance', ({ roomCode } = {}) => {
      try {
        const engine = getUcEngineForSocket(socket, roomCode, roomManager);
        if (!engine) return;

        const result = engine.hostAdvanceClue(socket.ucPlayerId);
        if (!result.success) return socket.emit('uc_error', { message: result.error });
      } catch (err) {
        console.error('[uc_host_advance]', err);
      }
    });

    // ── HOST START VOTE ───────────────────────────────────────
    socket.on('uc_host_start_vote', ({ roomCode } = {}) => {
      try {
        const engine = getUcEngineForSocket(socket, roomCode, roomManager);
        if (!engine) return;

        const result = engine.hostStartVote(socket.ucPlayerId);
        if (!result.success) return socket.emit('uc_error', { message: result.error });
      } catch (err) {
        console.error('[uc_host_start_vote]', err);
      }
    });

    // ── SUBMIT VOTE ───────────────────────────────────────────
    socket.on('uc_submit_vote', ({ roomCode, targetId } = {}) => {
      try {
        const engine = getUcEngineForSocket(socket, roomCode, roomManager);
        if (!engine) return;

        const result = engine.submitVote(socket.ucPlayerId, targetId);
        if (!result.success) return socket.emit('uc_error', { message: result.error });

        socket.emit('uc_action_confirmed', { message: 'Vote submitted.' });
      } catch (err) {
        console.error('[uc_submit_vote]', err);
        socket.emit('uc_error', { message: 'Failed to submit vote.' });
      }
    });

    // ── SUBMIT GUESS (blank / last undercover) ────────────────
    socket.on('uc_submit_guess', ({ roomCode, guess } = {}) => {
      try {
        const engine = getUcEngineForSocket(socket, roomCode, roomManager);
        if (!engine) return;

        const sanitized = sanitizeMessage(guess);
        const result = engine.submitGuess(socket.ucPlayerId, sanitized);
        if (!result.success) return socket.emit('uc_error', { message: result.error });

        socket.emit('uc_action_confirmed', { message: 'Guess submitted.' });
      } catch (err) {
        console.error('[uc_submit_guess]', err);
        socket.emit('uc_error', { message: 'Failed to submit guess.' });
      }
    });

    // ── REQUEST STATE ─────────────────────────────────────────
    socket.on('uc_request_state', ({ roomCode } = {}) => {
      try {
        const engine = getUcEngineForSocket(socket, roomCode, roomManager);
        if (!engine) return;

        const state = engine.phase === UC_PHASES.LOBBY
          ? engine.getLobbyState()
          : engine.getStateForPlayer(socket.ucPlayerId);
        socket.emit('uc_state_snapshot', { state });
      } catch (err) {
        console.error('[uc_request_state]', err);
        socket.emit('uc_error', { message: 'Could not retrieve state.' });
      }
    });

    // ── CHAT ──────────────────────────────────────────────────
    socket.on('uc_send_chat', ({ roomCode, message } = {}) => {
      try {
        const engine = getUcEngineForSocket(socket, roomCode, roomManager);
        if (!engine) return;

        const now = Date.now();
        if (now - (socket.ucLastChatTime || 0) < CHAT_RATE_LIMIT_MS) {
          return socket.emit('uc_error', { message: 'Sending too fast.' });
        }
        socket.ucLastChatTime = now;

        const player = engine.players.get(socket.ucPlayerId);
        if (!player) return;

        const msg = sanitizeMessage(message);
        if (!msg) return;

        // During clue giving: only the current clue-giver can send non-chat messages.
        // Chat is always allowed (no word hints naturally enforced by social pressure).
        // Dead players get ghost chat.
        if (!player.alive) {
          broadcastUcToDead(io, engine, 'uc_chat_message', {
            senderName: `👻 ${player.name}`,
            message:    msg,
            timestamp:  now,
            isDeadChat: true,
          });
          return;
        }

        io.to(engine.roomCode).emit('uc_chat_message', {
          senderName: player.name,
          message:    msg,
          timestamp:  now,
        });
      } catch (err) {
        console.error('[uc_send_chat]', err);
      }
    });

    // ── LEAVE ROOM ────────────────────────────────────────────
    socket.on('uc_leave_room', ({ roomCode } = {}) => {
      handleUcLeave(socket, roomCode || socket.ucRoomCode, io, roomManager, false);
    });

    // ── DISCONNECT ────────────────────────────────────────────
    socket.on('disconnect', () => {
      if (socket.ucRoomCode) {
        handleUcLeave(socket, socket.ucRoomCode, io, roomManager, true);
      }
    });
  });
}

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────

function handleUcLeave(socket, roomCode, io, roomManager, isDisconnect) {
  if (!roomCode || !socket.ucPlayerId) return;
  const store  = getUcStore(roomManager);
  const engine = getUcRoom(store, roomCode);
  if (!engine) return;

  const player     = engine.players.get(socket.ucPlayerId);
  const playerName = player?.name || 'A player';

  engine.removePlayer(socket.ucPlayerId);
  store.ucPlayerMap.delete(socket.ucPlayerId);
  socket.leave(roomCode);

  if (engine.phase === UC_PHASES.LOBBY) {
    if (engine.getPlayerCount() === 0) {
      deleteUcRoom(store, roomCode);
      return;
    }
    broadcastUcLobbyUpdate(io, engine, roomCode);
  }

  io.to(roomCode).emit('uc_player_left', {
    playerId: socket.ucPlayerId,
    playerName,
    isDisconnect,
  });

  if (engine.phase === UC_PHASES.GAME_OVER) {
    scheduleUcCleanup(io, store, roomCode, 5 * 60 * 1000);
  }
}

function getUcEngineForSocket(socket, roomCode, roomManager) {
  const code   = (roomCode || socket.ucRoomCode || '').toUpperCase().trim();
  const store  = getUcStore(roomManager);
  const engine = getUcRoom(store, code);
  if (!engine) {
    socket.emit('uc_error', { message: 'Room not found.' });
    return null;
  }
  return engine;
}

function broadcastUcLobbyUpdate(io, engine, roomCode) {
  io.to(roomCode).emit('uc_lobby_update', engine.getLobbyState());
}

function broadcastUcToDead(io, engine, eventName, data) {
  for (const p of engine.players.values()) {
    if (!p.alive && p.connected && p.socketId) {
      io.to(p.socketId).emit(eventName, data);
    }
  }
}

function sanitizeName(name) {
  if (typeof name !== 'string') return '';
  return name.trim().replace(/[<>]/g, '').slice(0, 20);
}

function sanitizeMessage(msg) {
  if (typeof msg !== 'string') return '';
  return msg.trim().replace(/[<>]/g, '').slice(0, MAX_CHAT_LENGTH);
}

module.exports = { registerUndercoverHandlers };
