/**
 * undercoverEngine.js — Core state machine for the Undercover / Imposter game.
 *
 * ─────────────────────────────────────────────────────────
 * GAME OVERVIEW
 * ─────────────────────────────────────────────────────────
 * Players are split into three roles:
 *   CIVILIAN    → receives Word A  (the majority)
 *   UNDERCOVER  → receives Word B  (similar but different)
 *   BLANK       → receives NO word (must bluff entirely; "Mr. White" variant)
 *
 * Each round:
 *   1. WORD_REVEAL  — every player privately sees their word (or "???" if Blank)
 *   2. CLUE_GIVING  — players take turns giving exactly ONE clue word/phrase
 *                     that hints at their word without saying it directly.
 *                     Turn order is randomised each round.
 *   3. DISCUSSION   — open free-for-all discussion (timed)
 *   4. VOTING       — players vote to eliminate the most suspicious person
 *   5. VOTE_RESULT  — reveal who was eliminated and their role
 *                     → if Blank is eliminated, Blank gets ONE GUESS chance
 *                       (they win if they correctly guess the civilian word)
 *   6. → either GAME_OVER or next round (CLUE_GIVING with survivors)
 *
 * ─────────────────────────────────────────────────────────
 * WIN CONDITIONS
 * ─────────────────────────────────────────────────────────
 *   Civilians win if:
 *     - All Undercovers AND all Blanks are eliminated
 *   Undercovers win if:
 *     - Undercovers remaining >= Civilians remaining  (outnumbered)
 *     - OR last surviving Undercover correctly guesses the civilian word
 *       (only triggered if eliminated as last undercover)
 *   Blank wins if:
 *     - Blank is eliminated AND correctly guesses the civilian word
 *     - OR Blank is the last person standing
 *
 * ─────────────────────────────────────────────────────────
 * ADMIN SETTINGS (configurable before game start)
 * ─────────────────────────────────────────────────────────
 *   category        : string key | 'random' | 'custom'
 *   customWordA     : string (only if category === 'custom')
 *   customWordB     : string
 *   undercoverCount : 1 | 2 (auto-capped based on player count)
 *   includeBlank    : boolean
 *   clueTimeLimit   : 30 | 60 | 90 | 0 (0 = unlimited / manual advance)
 *   discussTime     : 60 | 90 | 120 | 180
 *   voteTime        : 30 | 45 | 60
 *   showCategoryToAll : boolean (show category name to all players — makes game easier)
 *   allowSkipClue   : boolean (let a player pass their clue turn)
 *   revealRoleOnElim: boolean (reveal eliminated player's role immediately)
 *   maxRounds       : number | 0 (0 = play until win condition, max 20)
 */

const { getRandomPair, getRandomPairFromAny, validateCustomPair } = require('./wordPacks');

// ─────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────

const UC_ROLES = {
  CIVILIAN:   'civilian',
  UNDERCOVER: 'undercover',
  BLANK:      'blank',
};

const UC_TEAMS = {
  CIVILIAN:   'civilian',
  UNDERCOVER: 'undercover',
  BLANK:      'blank',
};

const UC_ROLE_META = {
  [UC_ROLES.CIVILIAN]: {
    label: 'Civilian',
    emoji: '👤',
    team: UC_TEAMS.CIVILIAN,
    description: 'You have the real word. Give clues that prove you know it without revealing it to the Undercover.',
  },
  [UC_ROLES.UNDERCOVER]: {
    label: 'Undercover',
    emoji: '🕵️',
    team: UC_TEAMS.UNDERCOVER,
    description: 'You have a similar but different word. Blend in with the Civilians — don\'t get caught!',
  },
  [UC_ROLES.BLANK]: {
    label: 'Blank',
    emoji: '❓',
    team: UC_TEAMS.BLANK,
    description: 'You have NO word. Listen to clues, figure out what everyone is talking about, and bluff your way through.',
  },
};

const UC_PHASES = {
  LOBBY:        'uc_lobby',
  WORD_REVEAL:  'uc_word_reveal',
  CLUE_GIVING:  'uc_clue_giving',
  DISCUSSION:   'uc_discussion',
  VOTING:       'uc_voting',
  VOTE_RESULT:  'uc_vote_result',
  BLANK_GUESS:  'uc_blank_guess',  // Blank gets a chance to guess if eliminated
  GAME_OVER:    'uc_game_over',
};

const DEFAULT_SETTINGS = {
  category:           'random',
  customWordA:        '',
  customWordB:        '',
  undercoverCount:    1,
  includeBlank:       false,
  clueTimeLimit:      60,      // seconds per clue; 0 = no timer
  discussTime:        90,      // seconds
  voteTime:           45,      // seconds
  showCategoryToAll:  false,
  allowSkipClue:      true,
  revealRoleOnElim:   true,
  maxRounds:          0,       // 0 = no limit
};

const MIN_PLAYERS = 3;
const MAX_PLAYERS = 12;

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ─────────────────────────────────────────────
// ENGINE CLASS
// ─────────────────────────────────────────────

class UndercoverEngine {
  constructor(roomCode, onEvent) {
    this.roomCode  = roomCode;
    this.onEvent   = onEvent || (() => {});

    /** Map<playerId, PlayerObj> */
    this.players   = new Map();

    this.phase     = UC_PHASES.LOBBY;
    this.round     = 0;
    this.hostId    = null;

    /** Admin-configurable settings */
    this.settings  = { ...DEFAULT_SETTINGS };

    /** Current round word pair */
    this.wordA     = '';   // civilian word
    this.wordB     = '';   // undercover word
    this.category  = '';
    this.categoryLabel = '';

    /** Clue-giving state */
    this.clueOrder      = [];   // [playerId, ...] ordered for current round
    this.clueIndex      = 0;   // whose turn it is
    this.clues          = [];   // [{ playerId, playerName, clue, skipped }]
    this.clueTimer      = null;
    this.clueEndTime    = null;

    /** Voting state */
    this.votes          = new Map();   // voterId → targetId
    this.skipVotes      = new Set();

    /** Blank guess state (after blank is eliminated) */
    this.blankGuessPlayerId  = null;
    this.blankGuessDeadline  = null;
    this.blankGuessTimer     = null;

    /** Phase timer */
    this.phaseTimer    = null;
    this.phaseEndTime  = null;

    /** Game log */
    this.eventLog      = [];

    /** Track if undercover used their "last survivor guess" already */
    this.undercoverLastGuessUsed = false;
  }

  // ─────────────────────────────────────────────
  // PLAYER MANAGEMENT
  // ─────────────────────────────────────────────

  addPlayer(playerId, playerName, socketId) {
    if (this.players.size >= MAX_PLAYERS) {
      return { success: false, error: `Room is full (max ${MAX_PLAYERS} players).` };
    }
    if (this.phase !== UC_PHASES.LOBBY) {
      return { success: false, error: 'Game already in progress.' };
    }
    if (this._getPlayerByName(playerName)) {
      return { success: false, error: 'That name is already taken.' };
    }

    const isFirst = this.players.size === 0;
    this.players.set(playerId, {
      id:        playerId,
      name:      playerName,
      role:      null,
      alive:     true,
      connected: true,
      socketId,
      hasGivenClue: false,
    });

    if (isFirst) this.hostId = playerId;
    return { success: true, isHost: isFirst };
  }

  removePlayer(playerId) {
    const player = this.players.get(playerId);
    if (!player) return;

    if (this.phase === UC_PHASES.LOBBY) {
      this.players.delete(playerId);
      if (playerId === this.hostId && this.players.size > 0) {
        this.hostId = this.players.keys().next().value;
      }
    } else {
      player.connected = false;
      player.alive     = false;
      this._log(`${player.name} disconnected and was removed from the game.`);

      // If it was this player's clue turn, advance
      if (this.phase === UC_PHASES.CLUE_GIVING) {
        const currentTurnId = this.clueOrder[this.clueIndex];
        if (currentTurnId === playerId) {
          this._advanceClueTurn();
        }
      }
      this._checkWinCondition();
    }
  }

  reconnectPlayer(playerId, newSocketId) {
    const p = this.players.get(playerId);
    if (!p) return { success: false, error: 'Player not found.' };
    p.socketId  = newSocketId;
    p.connected = true;
    return { success: true };
  }

  updateSocketId(playerId, socketId) {
    const p = this.players.get(playerId);
    if (p) p.socketId = socketId;
  }

  getPlayerCount()     { return this.players.size; }
  getAlivePlayers()    { return [...this.players.values()].filter(p => p.alive); }
  getConnectedPlayers(){ return [...this.players.values()].filter(p => p.connected); }

  _getPlayerByName(name) {
    return [...this.players.values()].find(
      p => p.name.toLowerCase() === name.toLowerCase()
    );
  }

  // ─────────────────────────────────────────────
  // SETTINGS (admin only)
  // ─────────────────────────────────────────────

  updateSettings(requesterId, newSettings) {
    if (requesterId !== this.hostId) {
      return { success: false, error: 'Only the host can change settings.' };
    }
    if (this.phase !== UC_PHASES.LOBBY) {
      return { success: false, error: 'Settings can only be changed in the lobby.' };
    }

    const allowed = [
      'category','customWordA','customWordB','undercoverCount',
      'includeBlank','clueTimeLimit','discussTime','voteTime',
      'showCategoryToAll','allowSkipClue','revealRoleOnElim','maxRounds',
    ];

    for (const [key, val] of Object.entries(newSettings)) {
      if (allowed.includes(key)) {
        this.settings[key] = val;
      }
    }

    // Validate custom words if category is custom
    if (this.settings.category === 'custom') {
      const v = validateCustomPair(this.settings.customWordA, this.settings.customWordB);
      if (!v.valid) return { success: false, error: v.error };
    }

    return { success: true, settings: this.settings };
  }

  // ─────────────────────────────────────────────
  // GAME START
  // ─────────────────────────────────────────────

  startGame(requesterId) {
    if (requesterId !== this.hostId) {
      return { success: false, error: 'Only the host can start the game.' };
    }
    if (this.players.size < MIN_PLAYERS) {
      return { success: false, error: `Need at least ${MIN_PLAYERS} players to start.` };
    }
    if (this.phase !== UC_PHASES.LOBBY) {
      return { success: false, error: 'Game already started.' };
    }

    // Validate undercover count vs player count
    const n = this.players.size;
    let ucCount = this.settings.undercoverCount;
    const hasBlank = this.settings.includeBlank;

    // Sanity caps: need at least 1 civilian majority
    const specialCount = ucCount + (hasBlank ? 1 : 0);
    if (specialCount >= n - 1) {
      ucCount = hasBlank ? 1 : Math.max(1, Math.floor((n - 1) / 2));
      this.settings.undercoverCount = ucCount;
    }

    this._assignRoles();
    this.round = 0;
    this._log('Game started!');
    this._startNewRound();
    return { success: true };
  }

  // ─────────────────────────────────────────────
  // ROUND MANAGEMENT
  // ─────────────────────────────────────────────

  _startNewRound() {
    this.round++;

    // Check max rounds
    if (this.settings.maxRounds > 0 && this.round > this.settings.maxRounds) {
      // Civilians win if max rounds reached without conclusion
      this._endGame('civilian', 'Maximum rounds reached. Civilians win!');
      return;
    }

    // Pick word pair
    this._selectWordPair();

    // Reset per-round state
    this.clueOrder   = shuffle(this.getAlivePlayers().map(p => p.id));
    this.clueIndex   = 0;
    this.clues       = [];
    this.votes       = new Map();
    this.skipVotes   = new Set();

    for (const p of this.players.values()) {
      p.hasGivenClue = false;
    }

    this._log(`Round ${this.round} begins. Words assigned.`);
    this._transitionTo(UC_PHASES.WORD_REVEAL);
  }

  _selectWordPair() {
    if (this.settings.category === 'custom') {
      this.wordA = this.settings.customWordA.trim();
      this.wordB = this.settings.customWordB.trim();
      this.category = 'custom';
      this.categoryLabel = 'Custom';
    } else if (this.settings.category === 'random') {
      const pair = getRandomPairFromAny();
      this.wordA = pair.wordA;
      this.wordB = pair.wordB;
      this.category = pair.category;
      this.categoryLabel = pair.categoryLabel;
    } else {
      const pair = getRandomPair(this.settings.category);
      this.wordA = pair.wordA;
      this.wordB = pair.wordB;
      this.category = pair.category;
      this.categoryLabel = pair.categoryLabel;
    }
  }

  _assignRoles() {
    const playerIds = shuffle([...this.players.keys()]);
    const ucCount   = this.settings.undercoverCount;
    const hasBlank  = this.settings.includeBlank;

    let idx = 0;
    for (let i = 0; i < ucCount; i++) {
      this.players.get(playerIds[idx++]).role = UC_ROLES.UNDERCOVER;
    }
    if (hasBlank) {
      this.players.get(playerIds[idx++]).role = UC_ROLES.BLANK;
    }
    while (idx < playerIds.length) {
      this.players.get(playerIds[idx++]).role = UC_ROLES.CIVILIAN;
    }
  }

  // ─────────────────────────────────────────────
  // PHASE TRANSITIONS
  // ─────────────────────────────────────────────

  _transitionTo(newPhase) {
    this._clearPhaseTimer();
    this.phase = newPhase;

    const durations = {
      [UC_PHASES.WORD_REVEAL]: 8000,
      [UC_PHASES.DISCUSSION]:  this.settings.discussTime * 1000,
      [UC_PHASES.VOTING]:      this.settings.voteTime * 1000,
      [UC_PHASES.VOTE_RESULT]: 6000,
      [UC_PHASES.BLANK_GUESS]: 30000,
    };

    const duration = durations[newPhase];
    if (duration) {
      this.phaseEndTime = Date.now() + duration;
      this.phaseTimer = setTimeout(() => this._onPhaseTimeout(), duration);
    } else {
      this.phaseEndTime = null;
    }

    this.onEvent('uc_phase_change', this._buildPhasePayload(newPhase));

    // After WORD_REVEAL, auto-advance to clue giving
    if (newPhase === UC_PHASES.WORD_REVEAL) {
      setTimeout(() => {
        if (this.phase === UC_PHASES.WORD_REVEAL) {
          this._startClueTurn();
        }
      }, 8000);
    }
  }

  _onPhaseTimeout() {
    switch (this.phase) {
      case UC_PHASES.DISCUSSION:
        this._transitionTo(UC_PHASES.VOTING);
        break;
      case UC_PHASES.VOTING:
        this._resolveVote();
        break;
      case UC_PHASES.VOTE_RESULT:
        this._checkWinCondition();
        break;
      case UC_PHASES.BLANK_GUESS:
        // Blank ran out of time — they don't guess
        this._resolveBlankGuess(null);
        break;
      default:
        break;
    }
  }

  _clearPhaseTimer() {
    if (this.phaseTimer) { clearTimeout(this.phaseTimer); this.phaseTimer = null; }
    this.phaseEndTime = null;
  }

  // ─────────────────────────────────────────────
  // CLUE GIVING
  // ─────────────────────────────────────────────

  _startClueTurn() {
    this._clearClueTurnTimer();

    // Skip dead players in clue order
    while (
      this.clueIndex < this.clueOrder.length &&
      !this.players.get(this.clueOrder[this.clueIndex])?.alive
    ) {
      this.clueIndex++;
    }

    // All alive players have given clues → move to discussion
    if (this.clueIndex >= this.clueOrder.length) {
      this._transitionTo(UC_PHASES.DISCUSSION);
      return;
    }

    this.phase = UC_PHASES.CLUE_GIVING;
    const currentPlayerId = this.clueOrder[this.clueIndex];
    const currentPlayer   = this.players.get(currentPlayerId);

    if (this.settings.clueTimeLimit > 0) {
      this.clueEndTime = Date.now() + this.settings.clueTimeLimit * 1000;
      this.clueTimer = setTimeout(() => {
        // Time ran out — auto-skip
        this._submitClueInternal(currentPlayerId, '', true);
      }, this.settings.clueTimeLimit * 1000);
    } else {
      this.clueEndTime = null;
    }

    this.onEvent('uc_clue_turn', {
      phase:          UC_PHASES.CLUE_GIVING,
      round:          this.round,
      currentPlayerId,
      currentPlayerName: currentPlayer?.name,
      clueIndex:      this.clueIndex,
      totalClues:     this.clueOrder.filter(id => this.players.get(id)?.alive).length,
      clues:          this.clues,
      clueEndTime:    this.clueEndTime,
      phaseEndTime:   this.clueEndTime,
    });
  }

  submitClue(playerId, clue) {
    if (this.phase !== UC_PHASES.CLUE_GIVING) {
      return { success: false, error: 'Not the clue-giving phase.' };
    }
    const currentTurnId = this.clueOrder[this.clueIndex];
    if (playerId !== currentTurnId) {
      return { success: false, error: 'It\'s not your turn to give a clue.' };
    }

    const player = this.players.get(playerId);
    if (!player?.alive) return { success: false, error: 'You are not in the game.' };

    const trimmedClue = (clue || '').trim();
    if (!trimmedClue && !this.settings.allowSkipClue) {
      return { success: false, error: 'You must give a clue.' };
    }

    return this._submitClueInternal(playerId, trimmedClue, false);
  }

  skipClue(playerId) {
    if (!this.settings.allowSkipClue) {
      return { success: false, error: 'Skipping clues is not allowed in this game.' };
    }
    if (this.phase !== UC_PHASES.CLUE_GIVING) {
      return { success: false, error: 'Not the clue-giving phase.' };
    }
    if (playerId !== this.clueOrder[this.clueIndex]) {
      return { success: false, error: 'It\'s not your turn.' };
    }
    return this._submitClueInternal(playerId, '', true);
  }

  _submitClueInternal(playerId, clue, skipped) {
    this._clearClueTurnTimer();

    const player = this.players.get(playerId);
    if (player) player.hasGivenClue = true;

    const entry = {
      playerId,
      playerName: player?.name || '?',
      clue:       skipped ? null : clue,
      skipped,
      round:      this.round,
    };
    this.clues.push(entry);
    this._log(skipped
      ? `${entry.playerName} passed their clue.`
      : `${entry.playerName} gave clue: "${clue}".`
    );

    this.onEvent('uc_clue_submitted', {
      entry,
      clues: this.clues,
    });

    this.clueIndex++;
    setTimeout(() => this._startClueTurn(), 800);
    return { success: true };
  }

  _clearClueTurnTimer() {
    if (this.clueTimer) { clearTimeout(this.clueTimer); this.clueTimer = null; }
    this.clueEndTime = null;
  }

  // ─────────────────────────────────────────────
  // VOTING
  // ─────────────────────────────────────────────

  submitVote(voterId, targetId) {
    if (this.phase !== UC_PHASES.VOTING) {
      return { success: false, error: 'Not the voting phase.' };
    }
    const voter = this.players.get(voterId);
    if (!voter?.alive) return { success: false, error: 'You cannot vote.' };

    if (targetId === 'skip') {
      this.skipVotes.add(voterId);
      this.votes.delete(voterId);
    } else {
      const target = this.players.get(targetId);
      if (!target?.alive) return { success: false, error: 'Invalid vote target.' };
      if (targetId === voterId) return { success: false, error: 'You cannot vote for yourself.' };
      this.votes.set(voterId, targetId);
      this.skipVotes.delete(voterId);
    }

    this.onEvent('uc_vote_update', this._buildVoteTally());

    // Auto-resolve if all alive players voted
    const aliveCount    = this.getAlivePlayers().length;
    const totalVoted    = this.votes.size + this.skipVotes.size;
    if (totalVoted >= aliveCount) {
      this._clearPhaseTimer();
      setTimeout(() => this._resolveVote(), 800);
    }
    return { success: true };
  }

  _resolveVote() {
    if (this.phase !== UC_PHASES.VOTING) return;
    this._clearPhaseTimer();

    const alivePlayers = this.getAlivePlayers();
    const aliveCount   = alivePlayers.length;
    const majority     = Math.floor(aliveCount / 2) + 1;

    // Count votes
    const voteCounts = new Map();
    for (const targetId of this.votes.values()) {
      voteCounts.set(targetId, (voteCounts.get(targetId) || 0) + 1);
    }

    let maxVotes = 0;
    let eliminatedId = null;
    let isTie = false;

    for (const [tid, count] of voteCounts) {
      if (count > maxVotes)      { maxVotes = count; eliminatedId = tid; isTie = false; }
      else if (count === maxVotes) { isTie = true; }
    }

    const skipCount = this.skipVotes.size;
    let eliminated = null;
    let voteResult;

    if (isTie || !eliminatedId || maxVotes < majority || skipCount >= majority) {
      voteResult = {
        eliminated: null,
        isTie,
        skipped:   skipCount >= majority,
        message:   isTie
          ? 'The vote ended in a tie — nobody was eliminated.'
          : skipCount >= majority
            ? 'The majority voted to skip — nobody was eliminated.'
            : 'Not enough votes to eliminate anyone.',
      };
      this._log(voteResult.message);
    } else {
      eliminated = this.players.get(eliminatedId);
      eliminated.alive = false;

      voteResult = {
        eliminated: this._publicPlayerInfo(eliminated, true),
        isTie:  false,
        skipped: false,
        message: `${eliminated.name} was voted out!` +
          (this.settings.revealRoleOnElim ? ` They were the ${UC_ROLE_META[eliminated.role].label}.` : ''),
      };
      this._log(voteResult.message);
    }

    this.onEvent('uc_vote_result', voteResult);

    // Check if eliminated blank gets a guess
    if (
      eliminated &&
      eliminated.role === UC_ROLES.BLANK &&
      this.settings.includeBlank
    ) {
      this.blankGuessPlayerId = eliminated.id;
      this._clearPhaseTimer();
      this.phase = UC_PHASES.BLANK_GUESS;
      this.blankGuessDeadline = Date.now() + 30000;
      this.blankGuessTimer = setTimeout(() => this._resolveBlankGuess(null), 30000);
      this.onEvent('uc_phase_change', this._buildPhasePayload(UC_PHASES.BLANK_GUESS));
      this.onEvent('uc_blank_guess_prompt', {
        playerId:  eliminated.id,
        playerName: eliminated.name,
        socketId:  eliminated.socketId,
        deadline:  this.blankGuessDeadline,
      });
      return;
    }

    // Check if eliminated last undercover gets a guess
    if (eliminated && eliminated.role === UC_ROLES.UNDERCOVER) {
      const remainingUndercovers = this.getAlivePlayers().filter(p => p.role === UC_ROLES.UNDERCOVER);
      if (remainingUndercovers.length === 0 && !this.undercoverLastGuessUsed) {
        this.undercoverLastGuessUsed = true;
        this._clearPhaseTimer();
        this.phase = UC_PHASES.BLANK_GUESS; // reuse same phase, different semantics
        this.blankGuessPlayerId = eliminated.id;
        this.blankGuessDeadline = Date.now() + 30000;
        this.blankGuessTimer = setTimeout(() => this._resolveBlankGuess(null), 30000);
        this.onEvent('uc_phase_change', this._buildPhasePayload(UC_PHASES.BLANK_GUESS));
        this.onEvent('uc_undercover_guess_prompt', {
          playerId:  eliminated.id,
          playerName: eliminated.name,
          socketId:  eliminated.socketId,
          deadline:  this.blankGuessDeadline,
          isUndercover: true,
        });
        return;
      }
    }

    // Normal: transition to VOTE_RESULT display then check win
    this._clearPhaseTimer();
    this.phase = UC_PHASES.VOTE_RESULT;
    this.phaseEndTime = null;
    this.onEvent('uc_phase_change', this._buildPhasePayload(UC_PHASES.VOTE_RESULT));

    this.phaseTimer = setTimeout(() => {
      if (this.phase === UC_PHASES.VOTE_RESULT) this._checkWinCondition();
    }, 6000);
  }

  // ─────────────────────────────────────────────
  // BLANK / UNDERCOVER GUESS
  // ─────────────────────────────────────────────

  submitGuess(playerId, guess) {
    if (this.phase !== UC_PHASES.BLANK_GUESS) {
      return { success: false, error: 'Not the guessing phase.' };
    }
    if (playerId !== this.blankGuessPlayerId) {
      return { success: false, error: 'It\'s not your turn to guess.' };
    }

    const trimmed = (guess || '').trim();
    if (!trimmed) return { success: false, error: 'Please enter a guess.' };

    this._resolveBlankGuess(trimmed);
    return { success: true };
  }

  _resolveBlankGuess(guess) {
    if (this.blankGuessTimer) { clearTimeout(this.blankGuessTimer); this.blankGuessTimer = null; }

    const guesser  = this.players.get(this.blankGuessPlayerId);
    const isUndercover = guesser?.role === UC_ROLES.UNDERCOVER;
    const correct  = guess && guess.toLowerCase() === this.wordA.toLowerCase();

    const resultData = {
      playerId:    guesser?.id,
      playerName:  guesser?.name,
      guess:       guess || null,
      correct,
      civilianWord: this.wordA,
      isUndercover,
    };

    this._log(
      guess
        ? `${guesser?.name} guessed "${guess}" — ${correct ? 'CORRECT!' : 'wrong.'}`
        : `${guesser?.name} didn't guess in time.`
    );

    this.onEvent('uc_guess_result', resultData);

    if (correct) {
      if (isUndercover) {
        this._endGame('undercover', `${guesser?.name} (Undercover) correctly guessed the civilian word "${this.wordA}"! Undercover wins!`);
      } else {
        this._endGame('blank', `${guesser?.name} (Blank) correctly guessed the civilian word "${this.wordA}"! Blank wins!`);
      }
    } else {
      // Wrong guess — check win condition normally
      this._clearPhaseTimer();
      this.phase = UC_PHASES.VOTE_RESULT;
      this.onEvent('uc_phase_change', this._buildPhasePayload(UC_PHASES.VOTE_RESULT));
      this.phaseTimer = setTimeout(() => {
        if (this.phase === UC_PHASES.VOTE_RESULT) this._checkWinCondition();
      }, 4000);
    }
  }

  // ─────────────────────────────────────────────
  // WIN CONDITIONS
  // ─────────────────────────────────────────────

  _checkWinCondition() {
    const alive             = this.getAlivePlayers();
    const aliveCivilians    = alive.filter(p => p.role === UC_ROLES.CIVILIAN);
    const aliveUndercovers  = alive.filter(p => p.role === UC_ROLES.UNDERCOVER);
    const aliveBlank        = alive.filter(p => p.role === UC_ROLES.BLANK);

    // Civilians win: no undercovers and no blanks remain
    if (aliveUndercovers.length === 0 && aliveBlank.length === 0) {
      this._endGame('civilian', 'All imposters eliminated. Civilians win!');
      return;
    }

    // Undercovers win: outnumber or equal civilians
    if (aliveUndercovers.length >= aliveCivilians.length) {
      this._endGame('undercover', 'Undercover agents now control the group. Undercover wins!');
      return;
    }

    // Blank wins: only blank remains
    if (alive.length === 1 && aliveBlank.length === 1) {
      this._endGame('blank', `${aliveBlank[0].name} (Blank) is the last one standing. Blank wins!`);
      return;
    }

    // Game continues — start next round
    this._startNewRound();
  }

  _endGame(winningTeam, message) {
    this._clearAll();
    this.phase = UC_PHASES.GAME_OVER;

    const allPlayers = [...this.players.values()].map(p => ({
      id:        p.id,
      name:      p.name,
      role:      p.role,
      roleMeta:  UC_ROLE_META[p.role],
      alive:     p.alive,
      team:      UC_ROLE_META[p.role]?.team,
    }));

    this._log(message);
    this.onEvent('uc_game_over', {
      winningTeam,
      message,
      players:    allPlayers,
      wordA:      this.wordA,
      wordB:      this.wordB,
      categoryLabel: this.categoryLabel,
      log:        this.eventLog,
    });
  }

  _clearAll() {
    this._clearPhaseTimer();
    this._clearClueTurnTimer();
    if (this.blankGuessTimer) { clearTimeout(this.blankGuessTimer); this.blankGuessTimer = null; }
  }

  // ─────────────────────────────────────────────
  // HOST: ADVANCE CLUE PHASE MANUALLY
  // ─────────────────────────────────────────────

  /**
   * Host can force-advance the clue timer (useful when clueTimeLimit=0).
   */
  hostAdvanceClue(requesterId) {
    if (requesterId !== this.hostId) {
      return { success: false, error: 'Only the host can advance the clue turn.' };
    }
    if (this.phase !== UC_PHASES.CLUE_GIVING) {
      return { success: false, error: 'Not in clue-giving phase.' };
    }
    const currentId = this.clueOrder[this.clueIndex];
    return this._submitClueInternal(currentId, '', true);
  }

  /**
   * Host can force-advance to voting from discussion.
   */
  hostStartVote(requesterId) {
    if (requesterId !== this.hostId) {
      return { success: false, error: 'Only the host can start the vote early.' };
    }
    if (this.phase !== UC_PHASES.DISCUSSION) {
      return { success: false, error: 'Can only start vote during discussion.' };
    }
    this._transitionTo(UC_PHASES.VOTING);
    return { success: true };
  }

  // ─────────────────────────────────────────────
  // STATE SNAPSHOTS
  // ─────────────────────────────────────────────

  /**
   * Role-sensitive state for a specific player.
   * KEY SECRECY RULES:
   *   - A player only sees their OWN word.
   *   - Undercovers NEVER see each other's word or role mid-game
   *     (unlike Mafia — undercovers are solo agents).
   *   - Blanks see "???" as their word.
   *   - Other players' roles are hidden until eliminated (if revealRoleOnElim=true)
   *     or until game over.
   */
  getStateForPlayer(playerId) {
    const me    = this.players.get(playerId);
    const myRole = me?.role;

    const publicPlayers = [...this.players.values()].map(p => {
      const isMe       = p.id === playerId;
      const isDead     = !p.alive;
      const isGameOver = this.phase === UC_PHASES.GAME_OVER;

      const pub = {
        id:         p.id,
        name:       p.name,
        alive:      p.alive,
        connected:  p.connected,
        isHost:     p.id === this.hostId,
        hasGivenClue: p.hasGivenClue,
      };

      // Role visibility: only own role, dead players (if revealRoleOnElim), or game over
      const roleRevealed = isMe || isGameOver || (isDead && this.settings.revealRoleOnElim);
      if (roleRevealed) {
        pub.role     = p.role;
        pub.roleMeta = UC_ROLE_META[p.role];
      }

      return pub;
    });

    // Word visibility: strict per-player
    let myWord = null;
    if (myRole === UC_ROLES.CIVILIAN)   myWord = this.wordA;
    if (myRole === UC_ROLES.UNDERCOVER) myWord = this.wordB;
    if (myRole === UC_ROLES.BLANK)      myWord = null; // Blank has no word

    return {
      roomCode:        this.roomCode,
      phase:           this.phase,
      round:           this.round,
      players:         publicPlayers,
      myId:            playerId,
      myRole,
      myRoleMeta:      myRole ? UC_ROLE_META[myRole] : null,
      myWord,                         // ONLY this player's word
      hasBlank:        this.settings.includeBlank,
      isHostPlayer:    playerId === this.hostId,

      // Category shown only if setting allows, or game over
      categoryLabel:   (this.settings.showCategoryToAll || this.phase === UC_PHASES.GAME_OVER)
                         ? this.categoryLabel : null,

      // Clue state
      clues:           this.clues,
      currentClueTurnId: this.phase === UC_PHASES.CLUE_GIVING
                          ? this.clueOrder[this.clueIndex] : null,
      clueEndTime:     this.clueEndTime,

      // Timer
      phaseEndTime:    this.phaseEndTime,

      // Voting
      voteTally:       this.phase === UC_PHASES.VOTING ? this._buildVoteTally() : null,
      myVote:          this.votes.get(playerId) || (this.skipVotes.has(playerId) ? 'skip' : null),

      // Settings (public subset)
      settings: {
        clueTimeLimit:       this.settings.clueTimeLimit,
        allowSkipClue:       this.settings.allowSkipClue,
        revealRoleOnElim:    this.settings.revealRoleOnElim,
        showCategoryToAll:   this.settings.showCategoryToAll,
        discussTime:         this.settings.discussTime,
        voteTime:            this.settings.voteTime,
      },

      eventLog:        this.eventLog,
    };
  }

  getLobbyState() {
    return {
      roomCode:   this.roomCode,
      phase:      this.phase,
      players:    [...this.players.values()].map(p => ({
        id:      p.id,
        name:    p.name,
        connected: p.connected,
        isHost:  p.id === this.hostId,
      })),
      hostId:     this.hostId,
      settings:   this.settings,
      minPlayers: MIN_PLAYERS,
      maxPlayers: MAX_PLAYERS,
      playerCount: this.players.size,
    };
  }

  _buildVoteTally() {
    const tally = {};
    for (const [voterId, targetId] of this.votes) {
      const voter  = this.players.get(voterId);
      const target = this.players.get(targetId);
      if (!tally[targetId]) {
        tally[targetId] = { targetName: target?.name, votes: [], count: 0 };
      }
      tally[targetId].votes.push({ voterId, voterName: voter?.name });
      tally[targetId].count++;
    }
    return {
      tally,
      skipCount:   this.skipVotes.size,
      totalVoted:  this.votes.size + this.skipVotes.size,
      totalAlive:  this.getAlivePlayers().length,
    };
  }

  _buildPhasePayload(phase) {
    return {
      phase,
      round:          this.round,
      phaseEndTime:   this.phaseEndTime,
      alivePlayers:   this.getAlivePlayers().map(p => ({ id: p.id, name: p.name })),
      clues:          this.clues,
      currentClueTurnId: phase === UC_PHASES.CLUE_GIVING ? this.clueOrder[this.clueIndex] : null,
    };
  }

  _publicPlayerInfo(p, revealRole = false) {
    return {
      id:       p.id,
      name:     p.name,
      alive:    p.alive,
      role:     revealRole ? p.role : undefined,
      roleMeta: revealRole ? UC_ROLE_META[p.role] : undefined,
    };
  }

  _log(message) {
    const entry = { round: this.round, phase: this.phase, message, time: Date.now() };
    this.eventLog.push(entry);
    if (this.eventLog.length > 200) this.eventLog.shift();
  }

  destroy() {
    this._clearAll();
  }
}

module.exports = {
  UndercoverEngine,
  UC_PHASES,
  UC_ROLES,
  UC_ROLE_META,
  UC_TEAMS,
  MIN_PLAYERS,
  MAX_PLAYERS,
  DEFAULT_SETTINGS,
};
