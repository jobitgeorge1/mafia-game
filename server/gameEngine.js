/**
 * GameEngine — the core state machine for a single Mafia game room.
 *
 * Phases (in order):
 *   LOBBY       → waiting for players, host can start
 *   NIGHT       → special roles act silently
 *   DAY_REVEAL  → results of the night are shown (brief)
 *   DAY_DISCUSS → players discuss openly (timed)
 *   DAY_VOTE    → players vote to eliminate someone (timed)
 *   VOTE_RESULT → result of vote shown (brief)
 *   GAME_OVER   → win condition met
 *
 * Emits events via an optional `onEvent(eventName, data)` callback
 * so the Socket.io layer can broadcast without being coupled to the engine.
 */

const { ROLES, TEAMS, ROLE_META, assignRoles } = require('./roles');

const PHASES = {
  LOBBY: 'lobby',
  NIGHT: 'night',
  DAY_REVEAL: 'day_reveal',
  DAY_DISCUSS: 'day_discuss',
  DAY_VOTE: 'day_vote',
  VOTE_RESULT: 'vote_result',
  GAME_OVER: 'game_over',
};

// Phase durations in milliseconds
const PHASE_DURATIONS = {
  [PHASES.NIGHT]: 30000,       // 30s for night actions
  [PHASES.DAY_REVEAL]: 5000,   // 5s to show what happened
  [PHASES.DAY_DISCUSS]: 90000, // 90s discussion
  [PHASES.DAY_VOTE]: 40000,    // 40s to cast votes
  [PHASES.VOTE_RESULT]: 5000,  // 5s show vote result
};

const MIN_PLAYERS = 4;
const MAX_PLAYERS = 12;

class GameEngine {
  constructor(roomCode, onEvent) {
    this.roomCode = roomCode;
    this.onEvent = onEvent || (() => {});

    // Player map: playerId → { id, name, role, alive, connected, socketId, hasActed }
    this.players = new Map();

    this.phase = PHASES.LOBBY;
    this.round = 0;
    this.hostId = null;

    // Night action tracking
    this.nightKillTarget = null;   // playerId targeted by Mafia
    this.nightSaveTarget = null;   // playerId targeted by Doctor
    this.mafiaVotes = new Map();   // mafiaPlayerId → targetId
    this.detectiveResult = null;   // { investigatorId, targetId, isMafia }

    // Day vote tracking
    this.dayVotes = new Map();     // voterId → targetId
    this.skipVotes = new Set();    // playerIds who voted to skip

    // Phase timer
    this.phaseTimer = null;
    this.phaseEndTime = null;

    // Log of events for the game journal
    this.eventLog = [];

    // Doctor self-save tracking (can only self-save once)
    this.doctorSelfSaveUsed = false;
  }

  // ─────────────────────────────────────────────
  // PLAYER MANAGEMENT
  // ─────────────────────────────────────────────

  addPlayer(playerId, playerName, socketId) {
    if (this.players.size >= MAX_PLAYERS) {
      return { success: false, error: 'Room is full (max 12 players).' };
    }
    if (this.phase !== PHASES.LOBBY) {
      return { success: false, error: 'Game already in progress.' };
    }
    if (this._getPlayerByName(playerName)) {
      return { success: false, error: 'That name is already taken.' };
    }

    const isFirst = this.players.size === 0;
    this.players.set(playerId, {
      id: playerId,
      name: playerName,
      role: null,
      alive: true,
      connected: true,
      socketId,
      hasActed: false,
    });

    if (isFirst) {
      this.hostId = playerId;
    }

    return { success: true, isHost: isFirst };
  }

  removePlayer(playerId) {
    const player = this.players.get(playerId);
    if (!player) return;

    if (this.phase === PHASES.LOBBY) {
      this.players.delete(playerId);

      // Reassign host if needed
      if (playerId === this.hostId && this.players.size > 0) {
        this.hostId = this.players.keys().next().value;
      }
    } else {
      // Mid-game: mark as disconnected but keep in game
      player.connected = false;
      player.alive = false; // treat disconnect as death
      this._log(`${player.name} has disconnected and was removed from the game.`);
      this._checkWinCondition();
    }
  }

  reconnectPlayer(playerId, newSocketId) {
    const player = this.players.get(playerId);
    if (!player) return { success: false, error: 'Player not found.' };

    player.socketId = newSocketId;
    player.connected = true;
    return { success: true };
  }

  updateSocketId(playerId, socketId) {
    const player = this.players.get(playerId);
    if (player) player.socketId = socketId;
  }

  getPlayerCount() {
    return this.players.size;
  }

  getAlivePlayers() {
    return Array.from(this.players.values()).filter(p => p.alive);
  }

  getConnectedPlayers() {
    return Array.from(this.players.values()).filter(p => p.connected);
  }

  _getPlayerByName(name) {
    return Array.from(this.players.values()).find(
      p => p.name.toLowerCase() === name.toLowerCase()
    );
  }

  // ─────────────────────────────────────────────
  // GAME LIFECYCLE
  // ─────────────────────────────────────────────

  startGame(requesterId) {
    if (requesterId !== this.hostId) {
      return { success: false, error: 'Only the host can start the game.' };
    }
    if (this.players.size < MIN_PLAYERS) {
      return { success: false, error: `Need at least ${MIN_PLAYERS} players to start.` };
    }
    if (this.phase !== PHASES.LOBBY) {
      return { success: false, error: 'Game already started.' };
    }

    // Assign roles
    const playerIds = Array.from(this.players.keys());
    const roleAssignments = assignRoles(playerIds);

    for (const [id, role] of roleAssignments) {
      this.players.get(id).role = role;
    }

    this.round = 0;
    this._log('Game started! Roles have been assigned.');
    this._transitionTo(PHASES.NIGHT);

    return { success: true };
  }

  // ─────────────────────────────────────────────
  // PHASE TRANSITIONS
  // ─────────────────────────────────────────────

  _transitionTo(newPhase) {
    this._clearTimer();
    this.phase = newPhase;

    // Reset per-phase tracking
    if (newPhase === PHASES.NIGHT) {
      this.round++;
      this.nightKillTarget = null;
      this.nightSaveTarget = null;
      this.mafiaVotes = new Map();
      this.detectiveResult = null;
      // Reset hasActed for all alive players with night actions
      for (const p of this.players.values()) {
        p.hasActed = false;
      }
    }

    if (newPhase === PHASES.DAY_VOTE) {
      this.dayVotes = new Map();
      this.skipVotes = new Set();
    }

    const duration = PHASE_DURATIONS[newPhase];
    if (duration) {
      this.phaseEndTime = Date.now() + duration;
      this.phaseTimer = setTimeout(() => this._onPhaseTimeout(), duration);
    } else {
      this.phaseEndTime = null;
    }

    this.onEvent('phase_change', this._buildPhasePayload(newPhase));
  }

  _onPhaseTimeout() {
    switch (this.phase) {
      case PHASES.NIGHT:
        this._resolveNight();
        break;
      case PHASES.DAY_REVEAL:
        this._transitionTo(PHASES.DAY_DISCUSS);
        break;
      case PHASES.DAY_DISCUSS:
        this._transitionTo(PHASES.DAY_VOTE);
        break;
      case PHASES.DAY_VOTE:
        this._resolveDayVote();
        break;
      default:
        break;
    }
  }

  _clearTimer() {
    if (this.phaseTimer) {
      clearTimeout(this.phaseTimer);
      this.phaseTimer = null;
    }
    this.phaseEndTime = null;
  }

  // ─────────────────────────────────────────────
  // NIGHT PHASE
  // ─────────────────────────────────────────────

  submitNightAction(actorId, targetId) {
    if (this.phase !== PHASES.NIGHT) {
      return { success: false, error: 'Not the night phase.' };
    }

    const actor = this.players.get(actorId);
    const target = this.players.get(targetId);

    if (!actor || !actor.alive) {
      return { success: false, error: 'You are not in this game or are eliminated.' };
    }
    if (!target || !target.alive) {
      return { success: false, error: 'Target is not valid.' };
    }
    if (actor.hasActed) {
      return { success: false, error: 'You have already acted this night.' };
    }

    switch (actor.role) {
      case ROLES.MAFIA:
        if (actor.id === targetId) {
          return { success: false, error: 'Mafia cannot target themselves.' };
        }
        if (target.role === ROLES.MAFIA) {
          return { success: false, error: 'Mafia cannot target other Mafia members.' };
        }
        this.mafiaVotes.set(actorId, targetId);
        actor.hasActed = true;
        this._checkAllMafiaVoted();
        break;

      case ROLES.DOCTOR:
        if (actor.id === targetId && this.doctorSelfSaveUsed) {
          return { success: false, error: 'You have already used your self-save.' };
        }
        if (actor.id === targetId) {
          this.doctorSelfSaveUsed = true;
        }
        this.nightSaveTarget = targetId;
        actor.hasActed = true;
        break;

      case ROLES.DETECTIVE:
        if (actor.id === targetId) {
          return { success: false, error: 'You cannot investigate yourself.' };
        }
        this.detectiveResult = {
          investigatorId: actorId,
          targetId,
          isMafia: target.role === ROLES.MAFIA,
          targetName: target.name,
        };
        actor.hasActed = true;
        break;

      default:
        return { success: false, error: 'Your role has no night action.' };
    }

    // Check if all night actions are complete to auto-advance
    this._checkNightComplete();

    return { success: true };
  }

  _checkAllMafiaVoted() {
    const aliveMafia = this.getAlivePlayers().filter(p => p.role === ROLES.MAFIA);
    if (aliveMafia.length === 0) return;
    const allVoted = aliveMafia.every(p => this.mafiaVotes.has(p.id));
    if (allVoted) {
      this.nightKillTarget = this._getMafiaConsensusTarget();
    }
  }

  _getMafiaConsensusTarget() {
    // Majority vote among mafia; ties broken by most-recent vote
    const voteCounts = new Map();
    for (const targetId of this.mafiaVotes.values()) {
      voteCounts.set(targetId, (voteCounts.get(targetId) || 0) + 1);
    }
    let maxVotes = 0;
    let result = null;
    for (const [targetId, count] of voteCounts) {
      if (count > maxVotes) {
        maxVotes = count;
        result = targetId;
      }
    }
    return result;
  }

  _checkNightComplete() {
    const alivePlayers = this.getAlivePlayers();
    const aliveMafia = alivePlayers.filter(p => p.role === ROLES.MAFIA);
    const aliveDetective = alivePlayers.find(p => p.role === ROLES.DETECTIVE);
    const aliveDoctor = alivePlayers.find(p => p.role === ROLES.DOCTOR);

    const mafiaReady = aliveMafia.length === 0 || aliveMafia.every(p => p.hasActed);
    const detectiveReady = !aliveDetective || aliveDetective.hasActed;
    const doctorReady = !aliveDoctor || aliveDoctor.hasActed;

    if (mafiaReady && detectiveReady && doctorReady) {
      // Small delay so clients don't see instant transition
      this._clearTimer();
      setTimeout(() => this._resolveNight(), 1500);
    }
  }

  _resolveNight() {
    if (this.phase !== PHASES.NIGHT) return;

    // Determine kill target from mafia consensus (if not already set)
    if (!this.nightKillTarget) {
      this.nightKillTarget = this._getMafiaConsensusTarget();
    }

    let killedPlayer = null;
    let savedPlayer = null;

    if (this.nightKillTarget) {
      if (this.nightKillTarget === this.nightSaveTarget) {
        // Doctor saved the target
        savedPlayer = this.players.get(this.nightSaveTarget);
        this._log(`${savedPlayer.name} was targeted by the Mafia but was saved by the Doctor!`);
      } else {
        killedPlayer = this.players.get(this.nightKillTarget);
        if (killedPlayer) {
          killedPlayer.alive = false;
          this._log(`${killedPlayer.name} was eliminated by the Mafia.`);
        }
      }
    } else {
      this._log('The Mafia could not agree on a target. Nobody was eliminated tonight.');
    }

    // Build the reveal payload
    const revealData = {
      phase: PHASES.DAY_REVEAL,
      round: this.round,
      killedPlayer: killedPlayer ? { id: killedPlayer.id, name: killedPlayer.name } : null,
      savedByDoctor: savedPlayer ? { id: savedPlayer.id, name: savedPlayer.name } : null,
      detectiveResult: null, // sent privately below
    };

    // Send detective result privately
    if (this.detectiveResult) {
      const detective = this.players.get(this.detectiveResult.investigatorId);
      if (detective && detective.alive) {
        this.onEvent('detective_result', {
          socketId: detective.socketId,
          targetName: this.detectiveResult.targetName,
          isMafia: this.detectiveResult.isMafia,
        });
      }
    }

    this.onEvent('night_result', revealData);
    this._transitionTo(PHASES.DAY_REVEAL);
  }

  // ─────────────────────────────────────────────
  // DAY VOTE PHASE
  // ─────────────────────────────────────────────

  submitDayVote(voterId, targetId) {
    if (this.phase !== PHASES.DAY_VOTE) {
      return { success: false, error: 'Not the voting phase.' };
    }

    const voter = this.players.get(voterId);
    if (!voter || !voter.alive) {
      return { success: false, error: 'You are not able to vote.' };
    }

    if (targetId === 'skip') {
      this.skipVotes.add(voterId);
      this.dayVotes.delete(voterId);
    } else {
      const target = this.players.get(targetId);
      if (!target || !target.alive) {
        return { success: false, error: 'Invalid vote target.' };
      }
      if (targetId === voterId) {
        return { success: false, error: 'You cannot vote for yourself.' };
      }
      this.dayVotes.set(voterId, targetId);
      this.skipVotes.delete(voterId);
    }

    // Broadcast current vote tally
    this.onEvent('vote_update', this._buildVoteTally());

    // Check if everyone alive has voted
    const alivePlayers = this.getAlivePlayers();
    const totalVoted = this.dayVotes.size + this.skipVotes.size;
    if (totalVoted >= alivePlayers.length) {
      this._clearTimer();
      setTimeout(() => this._resolveDayVote(), 1000);
    }

    return { success: true };
  }

  _resolveDayVote() {
    if (this.phase !== PHASES.DAY_VOTE) return;

    const alivePlayers = this.getAlivePlayers();
    const voteCounts = new Map();

    for (const targetId of this.dayVotes.values()) {
      voteCounts.set(targetId, (voteCounts.get(targetId) || 0) + 1);
    }

    let maxVotes = 0;
    let eliminatedId = null;
    let tie = false;

    for (const [targetId, count] of voteCounts) {
      if (count > maxVotes) {
        maxVotes = count;
        eliminatedId = targetId;
        tie = false;
      } else if (count === maxVotes) {
        tie = true;
      }
    }

    // Need majority (> 50% of alive players) to eliminate; tie or skip majority = no elimination
    const skipCount = this.skipVotes.size;
    const aliveCount = alivePlayers.length;
    const majority = Math.floor(aliveCount / 2) + 1;

    let eliminatedPlayer = null;
    let voteResult;

    if (tie || !eliminatedId || maxVotes < majority || skipCount >= majority) {
      voteResult = {
        eliminated: null,
        tie,
        skipped: skipCount >= majority,
        message: tie
          ? 'The vote ended in a tie. Nobody was eliminated.'
          : skipCount >= majority
          ? 'The majority voted to skip. Nobody was eliminated.'
          : 'Not enough votes to eliminate anyone.',
      };
      this._log(voteResult.message);
    } else {
      eliminatedPlayer = this.players.get(eliminatedId);
      eliminatedPlayer.alive = false;
      voteResult = {
        eliminated: {
          id: eliminatedPlayer.id,
          name: eliminatedPlayer.name,
          role: eliminatedPlayer.role,
          roleLabel: ROLE_META[eliminatedPlayer.role].label,
          roleEmoji: ROLE_META[eliminatedPlayer.role].emoji,
        },
        tie: false,
        skipped: false,
        message: `${eliminatedPlayer.name} was eliminated by vote. They were the ${ROLE_META[eliminatedPlayer.role].label}!`,
      };
      this._log(voteResult.message);
    }

    this.onEvent('vote_result', voteResult);
    // _transitionTo(VOTE_RESULT) has no duration entry, so no auto-timer fires.
    // We schedule win-check manually and guard with phase check.
    this._clearTimer();
    this.phase = PHASES.VOTE_RESULT;
    this.phaseEndTime = null;
    this.onEvent('phase_change', this._buildPhasePayload(PHASES.VOTE_RESULT));

    this.phaseTimer = setTimeout(() => {
      if (this.phase === PHASES.VOTE_RESULT) {
        this._checkWinCondition();
      }
    }, PHASE_DURATIONS[PHASES.VOTE_RESULT]);
  }

  // ─────────────────────────────────────────────
  // WIN CONDITION
  // ─────────────────────────────────────────────

  _checkWinCondition() {
    const alivePlayers = this.getAlivePlayers();
    const aliveMafia = alivePlayers.filter(p => p.role === ROLES.MAFIA);
    const aliveVillagers = alivePlayers.filter(p => p.role !== ROLES.MAFIA);

    if (aliveMafia.length === 0) {
      this._endGame(TEAMS.VILLAGE, 'All Mafia members have been eliminated. Village wins!');
      return true;
    }

    if (aliveMafia.length >= aliveVillagers.length) {
      this._endGame(TEAMS.MAFIA, 'The Mafia now controls the village. Mafia wins!');
      return true;
    }

    // Continue game
    if (this.phase !== PHASES.GAME_OVER) {
      this._transitionTo(PHASES.NIGHT);
    }
    return false;
  }

  _endGame(winningTeam, message) {
    this._clearTimer();
    this.phase = PHASES.GAME_OVER;

    const allPlayers = Array.from(this.players.values()).map(p => ({
      id: p.id,
      name: p.name,
      role: p.role,
      roleLabel: ROLE_META[p.role]?.label || 'Unknown',
      roleEmoji: ROLE_META[p.role]?.emoji || '❓',
      alive: p.alive,
      team: ROLE_META[p.role]?.team || 'village',
    }));

    this._log(message);
    this.onEvent('game_over', {
      winningTeam,
      message,
      players: allPlayers,
      log: this.eventLog,
    });
  }

  // ─────────────────────────────────────────────
  // STATE SNAPSHOTS (for clients)
  // ─────────────────────────────────────────────

  /**
   * Build a state snapshot for a specific player (role-sensitive).
   * Dead players and spectators see more information.
   */
  getStateForPlayer(playerId) {
    const requestingPlayer = this.players.get(playerId);
    const isAlive = requestingPlayer?.alive ?? false;
    const role = requestingPlayer?.role;

    const publicPlayers = Array.from(this.players.values()).map(p => {
      const base = {
        id: p.id,
        name: p.name,
        alive: p.alive,
        connected: p.connected,
        isHost: p.id === this.hostId,
        hasActed: p.hasActed,
      };

      // Reveal own role always
      if (p.id === playerId) {
        base.role = p.role;
        base.roleMeta = ROLE_META[p.role];
      }

      // Mafia see each other
      if (role === ROLES.MAFIA && p.role === ROLES.MAFIA) {
        base.role = p.role;
        base.roleMeta = ROLE_META[p.role];
      }

      // Dead players / game over: show all roles
      if (!isAlive || this.phase === PHASES.GAME_OVER) {
        base.role = p.role;
        base.roleMeta = ROLE_META[p.role];
      }

      return base;
    });

    return {
      roomCode: this.roomCode,
      phase: this.phase,
      round: this.round,
      players: publicPlayers,
      myId: playerId,
      myRole: role,
      myRoleMeta: role ? ROLE_META[role] : null,
      hostId: this.hostId,
      phaseEndTime: this.phaseEndTime,
      eventLog: this.eventLog,
      doctorSelfSaveUsed: role === ROLES.DOCTOR ? this.doctorSelfSaveUsed : undefined,
      voteTally: (this.phase === PHASES.DAY_VOTE) ? this._buildVoteTally() : null,
    };
  }

  getLobbyState() {
    return {
      roomCode: this.roomCode,
      phase: this.phase,
      playerCount: this.players.size,
      players: Array.from(this.players.values()).map(p => ({
        id: p.id,
        name: p.name,
        connected: p.connected,
        isHost: p.id === this.hostId,
      })),
      hostId: this.hostId,
      minPlayers: MIN_PLAYERS,
      maxPlayers: MAX_PLAYERS,
    };
  }

  _buildVoteTally() {
    const tally = {};
    for (const [voterId, targetId] of this.dayVotes) {
      const voter = this.players.get(voterId);
      const target = this.players.get(targetId);
      if (!tally[targetId]) {
        tally[targetId] = { targetName: target?.name, votes: [], count: 0 };
      }
      tally[targetId].votes.push({ voterId, voterName: voter?.name });
      tally[targetId].count++;
    }
    return {
      tally,
      skipCount: this.skipVotes.size,
      totalVoted: this.dayVotes.size + this.skipVotes.size,
      totalAlive: this.getAlivePlayers().length,
    };
  }

  _buildPhasePayload(phase) {
    return {
      phase,
      round: this.round,
      phaseEndTime: this.phaseEndTime,
      alivePlayers: this.getAlivePlayers().map(p => ({ id: p.id, name: p.name })),
    };
  }

  _log(message) {
    const entry = { round: this.round, phase: this.phase, message, time: Date.now() };
    this.eventLog.push(entry);
    // Keep log from growing unbounded
    if (this.eventLog.length > 100) this.eventLog.shift();
  }

  // Cleanup
  destroy() {
    this._clearTimer();
  }
}

module.exports = { GameEngine, PHASES, PHASE_DURATIONS, MIN_PLAYERS, MAX_PLAYERS };
