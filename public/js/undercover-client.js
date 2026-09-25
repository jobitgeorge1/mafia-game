/**
 * undercover-client.js — Frontend client for the Undercover / Imposter game.
 *
 * Completely isolated from client.js — own UCState object, own socket events
 * (all uc_ prefixed), own screen/panel renderers. Shares only:
 *   - The Socket.io connection object (State.socket from client.js — read-only)
 *   - Global utility functions: toast(), escHtml(), qs() — defined in client.js
 *   - The #toast-container, #connection-bar, #modal-overlay DOM elements
 *   - showScreen() — switches between all screens including UC screens
 *
 * SECRECY MODEL:
 *   - myWord is received ONLY via uc_game_started (server sends per-socket)
 *   - It is stored ONLY in UCState.myWord — never broadcast or logged
 *   - All other player data from state_snapshot never includes other players' words
 *   - The word is shown in a modal (private) then in the word pill header
 */

// ─────────────────────────────────────────────
// STATE
// ─────────────────────────────────────────────
const UCState = {
  playerId:      null,
  playerName:    null,
  roomCode:      null,
  isHost:        false,

  gameState:     null,   // latest full state snapshot
  phase:         null,
  myRole:        null,
  myRoleMeta:    null,
  myWord:        null,   // PRIVATE — only this client ever sees this value

  categories:    [],     // category list from server

  // Clue giving
  clueSubmitted: false,

  // Voting
  myVote:        null,

  // Guess (blank/undercover)
  isMyGuessTurn: false,

  // Timer
  timerInterval: null,
  phaseEndTime:  null,
  clueTimerInterval: null,
};

const UC_SESSION_KEY = 'uc_session';
const PLAYER_AVATARS = ['🧑','👩','👨','🧔','👱','🧕','👲','🧓','👴','👵','🧑‍🦰','🧑‍🦱'];
const CIRCUMFERENCE  = 2 * Math.PI * 18;

const UC_PHASE_LABELS = {
  uc_lobby:        { label: 'Lobby',       cls: '' },
  uc_word_reveal:  { label: 'Word Reveal', cls: 'phase-uc-word' },
  uc_clue_giving:  { label: 'Clue Giving', cls: 'phase-uc-clue' },
  uc_discussion:   { label: 'Discussion',  cls: 'phase-uc-discuss' },
  uc_voting:       { label: 'Voting',      cls: 'phase-uc-vote' },
  uc_vote_result:  { label: 'Result',      cls: 'phase-uc-vote' },
  uc_blank_guess:  { label: 'Last Guess',  cls: 'phase-uc-guess' },
  uc_game_over:    { label: 'Game Over',   cls: 'phase-gameover' },
};

// ─────────────────────────────────────────────
// INIT — runs after client.js DOMContentLoaded
// ─────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  bindGamePickerEvents();
  bindUcHomeEvents();
  bindUcLobbyEvents();
  bindUcGameEvents();
  // Socket is initialised by client.js; we attach our listeners after a tick
  setTimeout(initUcSocket, 0);
  attemptUcReconnect();
});

// ─────────────────────────────────────────────
// GAME PICKER (home screen toggle)
// ─────────────────────────────────────────────
function bindGamePickerEvents() {
  qs('#pick-mafia')?.addEventListener('click', () => switchGamePicker('mafia'));
  qs('#pick-undercover')?.addEventListener('click', () => switchGamePicker('undercover'));
}

function switchGamePicker(game) {
  document.body.classList.toggle('game-undercover', game === 'undercover');
  qs('#pick-mafia')?.classList.toggle('active', game === 'mafia');
  qs('#pick-undercover')?.classList.toggle('active', game === 'undercover');

  // Toggle card visibility directly
  document.querySelectorAll('.card.mafia-card').forEach(c => {
    c.style.display = game === 'undercover' ? 'none' : '';
  });
  document.querySelectorAll('.card.uc-card').forEach(c => {
    c.style.display = game === 'undercover' ? '' : 'none';
  });

  // Switch rules panel content
  qs('#rules-mafia')?.classList.toggle('hidden', game === 'undercover');
  qs('#rules-undercover')?.classList.toggle('hidden', game === 'mafia');

  // Clear errors
  qs('#home-error')?.classList.add('hidden');
  qs('#uc-home-error')?.classList.add('hidden');
}

// ─────────────────────────────────────────────
// HOME SCREEN — UC CREATE / JOIN
// ─────────────────────────────────────────────
function bindUcHomeEvents() {
  qs('#uc-btn-create')?.addEventListener('click', () => {
    const name = ucSanitizeName(qs('#uc-create-name')?.value || '');
    if (!ucValidateName(name)) return;
    clearUcHomeError();
    getSocket().emit('uc_create_room', { playerName: name });
  });

  qs('#uc-create-name')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') qs('#uc-btn-create')?.click();
  });

  qs('#uc-btn-join')?.addEventListener('click', () => {
    const name = ucSanitizeName(qs('#uc-join-name')?.value || '');
    const code = (qs('#uc-join-code')?.value || '').trim().toUpperCase();
    if (!ucValidateName(name)) return;
    if (!code || code.length !== 6) { showUcHomeError('Enter a 6-character room code.'); return; }
    clearUcHomeError();
    getSocket().emit('uc_join_room', { roomCode: code, playerName: name });
  });

  qs('#uc-join-name')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') qs('#uc-join-code')?.focus();
  });
  qs('#uc-join-code')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') qs('#uc-btn-join')?.click();
  });
  qs('#uc-join-code')?.addEventListener('input', e => {
    e.target.value = e.target.value.toUpperCase();
  });
}

// ─────────────────────────────────────────────
// LOBBY EVENTS
// ─────────────────────────────────────────────
function bindUcLobbyEvents() {
  qs('#uc-btn-copy-code')?.addEventListener('click', () => {
    const code = qs('#uc-lobby-room-code')?.textContent;
    navigator.clipboard?.writeText(code).then(() => toast('Room code copied!', 'success'));
  });

  qs('#uc-btn-start')?.addEventListener('click', () => {
    getSocket().emit('uc_start_game', { roomCode: UCState.roomCode });
  });

  qs('#uc-btn-leave-lobby')?.addEventListener('click', () => {
    getSocket().emit('uc_leave_room', { roomCode: UCState.roomCode });
    clearUcSession();
    showScreen('home');
  });

  // Settings controls (host only — changes sent on each interaction)
  bindSettingsControls();
}

function bindSettingsControls() {
  // Category select
  qs('#uc-setting-category')?.addEventListener('change', e => {
    const val = e.target.value;
    qs('#uc-custom-words-row').style.display = val === 'custom' ? '' : 'none';
    emitSettingsChange({ category: val });
  });

  // Custom words — debounced
  let customDebounce;
  ['#uc-custom-word-a', '#uc-custom-word-b'].forEach(sel => {
    qs(sel)?.addEventListener('input', () => {
      clearTimeout(customDebounce);
      customDebounce = setTimeout(() => {
        emitSettingsChange({
          customWordA: qs('#uc-custom-word-a')?.value || '',
          customWordB: qs('#uc-custom-word-b')?.value || '',
        });
      }, 600);
    });
  });

  // Toggle groups (data-val attribute)
  [
    ['#uc-undercover-count-group', 'undercoverCount', v => parseInt(v)],
    ['#uc-include-blank-group',    'includeBlank',    v => v === 'true'],
    ['#uc-clue-time-group',        'clueTimeLimit',   v => parseInt(v)],
    ['#uc-discuss-time-group',     'discussTime',     v => parseInt(v)],
    ['#uc-vote-time-group',        'voteTime',        v => parseInt(v)],
  ].forEach(([groupSel, key, parse]) => {
    qs(groupSel)?.addEventListener('click', e => {
      const btn = e.target.closest('.stg-btn');
      if (!btn) return;
      qs(groupSel).querySelectorAll('.stg-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      emitSettingsChange({ [key]: parse(btn.dataset.val) });
    });
  });

  // Checkboxes
  [
    ['#uc-show-category', 'showCategoryToAll'],
    ['#uc-allow-skip',    'allowSkipClue'],
    ['#uc-reveal-role',   'revealRoleOnElim'],
  ].forEach(([sel, key]) => {
    qs(sel)?.addEventListener('change', e => {
      emitSettingsChange({ [key]: e.target.checked });
    });
  });

  // Max rounds
  let roundsDebounce;
  qs('#uc-max-rounds')?.addEventListener('input', e => {
    clearTimeout(roundsDebounce);
    roundsDebounce = setTimeout(() => {
      const val = Math.max(0, Math.min(20, parseInt(e.target.value) || 0));
      emitSettingsChange({ maxRounds: val });
    }, 500);
  });
}

function emitSettingsChange(partial) {
  if (!UCState.isHost) return;
  getSocket().emit('uc_update_settings', { roomCode: UCState.roomCode, settings: partial });
}

// ─────────────────────────────────────────────
// GAME EVENTS (chat, vote, clue, guess)
// ─────────────────────────────────────────────
function bindUcGameEvents() {
  qs('#uc-btn-chat-send')?.addEventListener('click', sendUcChat);
  qs('#uc-chat-input')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') sendUcChat();
  });

  qs('#uc-btn-vote-skip')?.addEventListener('click', () => submitUcVote('skip'));
  qs('#uc-btn-host-advance')?.addEventListener('click', () => {
    getSocket().emit('uc_host_advance', { roomCode: UCState.roomCode });
  });
  qs('#uc-btn-host-start-vote')?.addEventListener('click', () => {
    getSocket().emit('uc_host_start_vote', { roomCode: UCState.roomCode });
  });

  qs('#uc-btn-submit-guess')?.addEventListener('click', submitUcGuess);
  qs('#uc-guess-field')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') submitUcGuess();
  });

  qs('#uc-btn-toggle-log')?.addEventListener('click', () => {
    qs('#uc-event-log-panel')?.classList.toggle('hidden');
  });
}

function sendUcChat() {
  const input = qs('#uc-chat-input');
  const msg = (input?.value || '').trim();
  if (!msg) return;
  getSocket().emit('uc_send_chat', { roomCode: UCState.roomCode, message: msg });
  input.value = '';
}

function submitUcVote(targetId) {
  getSocket().emit('uc_submit_vote', { roomCode: UCState.roomCode, targetId });
  UCState.myVote = targetId;
  // Visual feedback
  qs('#uc-vote-action-area')?.querySelectorAll('.vote-btn').forEach(btn => {
    btn.classList.toggle('voted', btn.dataset.targetId === targetId);
  });
  qs('#uc-btn-vote-skip')?.classList.toggle('btn-primary', targetId === 'skip');
  qs('#uc-btn-vote-skip')?.classList.toggle('btn-ghost', targetId !== 'skip');
}

function submitUcGuess() {
  const field = qs('#uc-guess-field');
  const guess = (field?.value || '').trim();
  if (!guess) { toast('Please enter a guess.', 'error'); return; }
  getSocket().emit('uc_submit_guess', { roomCode: UCState.roomCode, guess });
  if (field) field.disabled = true;
  qs('#uc-btn-submit-guess')?.setAttribute('disabled', true);
}

// ─────────────────────────────────────────────
// SOCKET — attach listeners to existing socket
// ─────────────────────────────────────────────
function initUcSocket() {
  const s = getSocket();
  if (!s) { setTimeout(initUcSocket, 100); return; }

  // ── Room created ──────────────────────────
  s.on('uc_room_created', ({ roomCode, playerId, playerName, categories }) => {
    UCState.playerId    = playerId;
    UCState.playerName  = playerName;
    UCState.roomCode    = roomCode;
    UCState.isHost      = true;
    UCState.categories  = categories || [];
    saveUcSession();
    showScreen('uc-lobby');
    qs('#uc-lobby-room-code').textContent = roomCode;
    populateCategorySelect(categories);
    showHostSettings(true);
    toast(`Room ${roomCode} created!`, 'success');
  });

  // ── Room joined ───────────────────────────
  s.on('uc_room_joined', ({ roomCode, playerId, playerName, isHost, state, categories }) => {
    UCState.playerId   = playerId;
    UCState.playerName = playerName;
    UCState.roomCode   = roomCode;
    UCState.isHost     = isHost;
    UCState.categories = categories || [];
    saveUcSession();
    showScreen('uc-lobby');
    qs('#uc-lobby-room-code').textContent = roomCode;
    populateCategorySelect(categories);
    showHostSettings(isHost);
    renderUcLobby(state);
    toast(`Joined room ${roomCode}`, 'success');
  });

  // ── Lobby update ──────────────────────────
  s.on('uc_lobby_update', state => {
    const me = (state.players || []).find(p => p.id === UCState.playerId);
    if (me) UCState.isHost = state.hostId === UCState.playerId;
    if (state.roomCode) qs('#uc-lobby-room-code').textContent = state.roomCode;
    renderUcLobby(state);
    showHostSettings(UCState.isHost);
  });

  // ── Settings updated ──────────────────────
  s.on('uc_settings_updated', ({ settings }) => {
    if (!UCState.isHost) renderSettingsView(settings);
    syncSettingsUI(settings);
  });

  // ── Game started ──────────────────────────
  s.on('uc_game_started', ({ state }) => {
    UCState.gameState      = state;
    UCState.phase          = state.phase;
    UCState.myRole         = state.myRole;
    UCState.myRoleMeta     = state.myRoleMeta;
    UCState.myWord         = state.myWord;   // PRIVATE — only stored here
    UCState.clueSubmitted  = false;
    UCState.myVote         = null;
    UCState.isMyGuessTurn  = false;

    showScreen('uc-game');
    renderUcPhaseHeader(state.phase, state.round);
    renderUcPlayerList(state.players);
    renderUcWordPill(state.myRole, state.myWord);
    showWordRevealModal(state);
    renderUcPhasePanel(state.phase, state);
    if (state.phaseEndTime) startUcTimer(state.phaseEndTime);
  });

  // ── Phase change ──────────────────────────
  s.on('uc_phase_change', data => {
    UCState.phase        = data.phase;
    UCState.phaseEndTime = data.phaseEndTime || null;
    UCState.clueSubmitted = false;
    UCState.myVote       = null;
    UCState.isMyGuessTurn = false;

    renderUcPhaseHeader(data.phase, data.round);
    startUcTimer(data.phaseEndTime);

    // Handle blank guess phase announcement
    if (data.phase === 'uc_blank_guess') {
      renderUcBlankGuessPanel(data.guesserName, data.isUndercover, false);
      showUcPanel('uc-panel-blank-guess');
    }

    // Request fresh state to get updated player list & clues
    getSocket().emit('uc_request_state', { roomCode: UCState.roomCode });
  });

  // ── State snapshot ────────────────────────
  s.on('uc_state_snapshot', ({ state }) => {
    // IMPORTANT: preserve myWord — it is NOT in state snapshots
    const savedWord = UCState.myWord;
    UCState.gameState  = state;
    UCState.phase      = state.phase;
    UCState.myRole     = state.myRole;
    UCState.myRoleMeta = state.myRoleMeta;
    UCState.myWord     = savedWord; // restore — never overwrite from snapshot

    if (state.phase === 'uc_lobby') {
      showScreen('uc-lobby');
      renderUcLobby(state);
      showHostSettings(UCState.isHost);
      return;
    }

    showScreen('uc-game');
    renderUcPhaseHeader(state.phase, state.round);
    renderUcPlayerList(state.players);
    renderUcWordPill(state.myRole, UCState.myWord);

    const resultPhases = ['uc_word_reveal','uc_vote_result','uc_game_over','uc_blank_guess'];
    if (!resultPhases.includes(state.phase)) {
      renderUcPhasePanel(state.phase, state);
    }
    if (state.phaseEndTime) startUcTimer(state.phaseEndTime);
    if (state.voteTally && state.phase === 'uc_voting') {
      renderUcVoteTally(state.voteTally);
      updateUcVoteButtons(state.voteTally);
    }
  });

  // ── Clue turn ─────────────────────────────
  s.on('uc_clue_turn', data => {
    UCState.phase = 'uc_clue_giving';
    if (data.clueEndTime) startUcClueTimer(data.clueEndTime);
    renderClueTurnUpdate(data);
  });

  // ── Clue submitted ────────────────────────
  s.on('uc_clue_submitted', ({ entry, clues }) => {
    stopUcClueTimer();
    appendClueEntry(entry, clues);
    // Request state so board refreshes cleanly
    getSocket().emit('uc_request_state', { roomCode: UCState.roomCode });
  });

  // ── Vote update ───────────────────────────
  s.on('uc_vote_update', tally => {
    renderUcVoteTally(tally);
    updateUcVoteButtons(tally);
  });

  // ── Vote result ───────────────────────────
  s.on('uc_vote_result', result => {
    renderUcVoteResult(result);
    showUcPanel('uc-panel-vote-result');
    getSocket().emit('uc_request_state', { roomCode: UCState.roomCode });
  });

  // ── Blank guess prompt (private) ──────────
  s.on('uc_blank_guess_prompt', data => {
    UCState.isMyGuessTurn = true;
    renderUcBlankGuessPanel(data.playerName, false, true, data.deadline);
    showUcPanel('uc-panel-blank-guess');
    startUcGuessCountdown(data.deadline);
  });

  // ── Undercover guess prompt (private) ─────
  s.on('uc_undercover_guess_prompt', data => {
    UCState.isMyGuessTurn = true;
    renderUcBlankGuessPanel(data.playerName, true, true, data.deadline);
    showUcPanel('uc-panel-blank-guess');
    startUcGuessCountdown(data.deadline);
  });

  // ── Guess result ──────────────────────────
  s.on('uc_guess_result', result => {
    stopUcClueTimer();
    addUcSystemChat(
      result.correct
        ? `🎯 ${escHtml(result.playerName)} guessed "${escHtml(result.guess)}" — CORRECT! ${result.isUndercover ? 'Undercover' : 'Blank'} wins!`
        : `❌ ${escHtml(result.playerName)} guessed "${escHtml(result.guess || '?')}" — Wrong!`
    );
    toast(result.correct ? '🎯 Correct guess!' : '❌ Wrong guess!', result.correct ? 'success' : 'error', 4000);
  });

  // ── Game over ─────────────────────────────
  s.on('uc_game_over', data => {
    UCState.phase = 'uc_game_over';
    stopUcTimer();
    stopUcClueTimer();
    renderUcPhaseHeader('uc_game_over', UCState.gameState?.round || 0);
    renderUcGameOver(data);
    showUcPanel('uc-panel-game-over');
  });

  // ── Chat ──────────────────────────────────
  s.on('uc_chat_message', ({ senderName, message, timestamp, isDeadChat }) => {
    addUcChatMessage(senderName, message, timestamp, isDeadChat);
  });

  // ── Player left ───────────────────────────
  s.on('uc_player_left', ({ playerName, isDisconnect }) => {
    const reason = isDisconnect ? 'disconnected' : 'left';
    toast(`${playerName} ${reason}.`, 'warning');
    addUcSystemChat(`${playerName} ${reason}.`);
  });

  // ── Action confirmed ──────────────────────
  s.on('uc_action_confirmed', ({ message }) => {
    toast(message, 'success');
  });

  // ── Error ─────────────────────────────────
  s.on('uc_error', ({ message }) => {
    toast(message, 'error');
    showUcHomeError(message);
  });

  // ── Room closed ───────────────────────────
  s.on('uc_room_closed', ({ reason }) => {
    clearUcSession();
    toast(reason || 'Room was closed.', 'warning', 5000);
    setTimeout(() => showScreen('home'), 3000);
  });
}

// ─────────────────────────────────────────────
// LOBBY RENDERING
// ─────────────────────────────────────────────
function renderUcLobby(state) {
  if (!state) return;
  const { players = [], hostId, minPlayers = 3, maxPlayers = 12 } = state;
  const count = players.length;

  qs('#uc-lobby-player-count').textContent = `${count} / ${maxPlayers} players`;

  const list = qs('#uc-lobby-player-list');
  list.innerHTML = '';
  players.forEach((p, i) => {
    const isYou  = p.id === UCState.playerId;
    const isHost = p.id === hostId;
    const li = document.createElement('li');
    li.className = `player-list-item${isYou ? ' is-you' : ''}`;
    li.innerHTML = `
      <div class="player-avatar">${PLAYER_AVATARS[i % PLAYER_AVATARS.length]}</div>
      <span class="player-name">${escHtml(p.name)}</span>
      ${isHost ? '<span class="player-host-badge">Host</span>' : ''}
      ${isYou  ? '<span class="player-you-badge">You</span>' : ''}
      ${!p.connected ? '<span class="player-tag">(offline)</span>' : ''}
    `;
    list.appendChild(li);
  });

  const isHost = hostId === UCState.playerId;
  const canStart = isHost && count >= minPlayers;
  const startBtn = qs('#uc-btn-start');
  startBtn.disabled = !canStart;
  startBtn.style.display = isHost ? '' : 'none';

  qs('#uc-host-note').textContent = isHost
    ? (count < minPlayers
        ? `Need ${minPlayers - count} more player${minPlayers - count !== 1 ? 's' : ''} to start.`
        : 'Ready to start!')
    : `Waiting for host to start…`;

  qs('#uc-lobby-hint').textContent = count < minPlayers
    ? `Waiting for players… (need at least ${minPlayers})`
    : `${count} players ready!`;

  if (state.settings) {
    if (!isHost) renderSettingsView(state.settings);
    syncSettingsUI(state.settings);
  }
}

function showHostSettings(isHost) {
  qs('#uc-settings-panel')?.classList.toggle('hidden', !isHost);
  qs('#uc-settings-view')?.classList.toggle('hidden', isHost);
}

function populateCategorySelect(categories) {
  const sel = qs('#uc-setting-category');
  if (!sel || !categories?.length) return;
  // Keep the 'random' option, add categories
  sel.innerHTML = '<option value="random">🎲 Random (any category)</option>';
  categories.forEach(cat => {
    const opt = document.createElement('option');
    opt.value = cat.key;
    opt.textContent = `${cat.emoji} ${cat.label} (${cat.pairCount} pairs)`;
    sel.appendChild(opt);
  });
  const customOpt = document.createElement('option');
  customOpt.value = 'custom';
  customOpt.textContent = '✏️ Custom Words';
  sel.appendChild(customOpt);
}

function renderSettingsView(settings) {
  const container = qs('#uc-settings-view-content');
  if (!container) return;
  const rows = [
    ['Category',   settings.category === 'random' ? 'Random' : settings.category === 'custom' ? 'Custom' : settings.category],
    ['Undercovers', settings.undercoverCount],
    ['Blank',      settings.includeBlank ? 'On' : 'Off'],
    ['Clue Timer', settings.clueTimeLimit === 0 ? 'None' : `${settings.clueTimeLimit}s`],
    ['Discussion', `${settings.discussTime}s`],
    ['Vote Timer', `${settings.voteTime}s`],
    ['Show Category', settings.showCategoryToAll ? 'Yes' : 'No'],
    ['Reveal on Elim', settings.revealRoleOnElim ? 'Yes' : 'No'],
    ['Max Rounds', settings.maxRounds === 0 ? 'Unlimited' : settings.maxRounds],
  ];
  container.innerHTML = rows.map(([k, v]) =>
    `<div class="uc-settings-view-row"><span>${k}</span><span>${escHtml(String(v))}</span></div>`
  ).join('');
}

/** Sync the settings panel UI to match server state (so late-joiners see correct state) */
function syncSettingsUI(settings) {
  if (!UCState.isHost) return;

  // Category
  const catSel = qs('#uc-setting-category');
  if (catSel && settings.category) catSel.value = settings.category;
  if (qs('#uc-custom-words-row')) {
    qs('#uc-custom-words-row').style.display = settings.category === 'custom' ? '' : 'none';
  }

  // Toggle groups
  const groups = {
    '#uc-undercover-count-group': String(settings.undercoverCount),
    '#uc-include-blank-group':    String(settings.includeBlank),
    '#uc-clue-time-group':        String(settings.clueTimeLimit),
    '#uc-discuss-time-group':     String(settings.discussTime),
    '#uc-vote-time-group':        String(settings.voteTime),
  };
  for (const [sel, val] of Object.entries(groups)) {
    qs(sel)?.querySelectorAll('.stg-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.val === val);
    });
  }

  // Checkboxes
  if (qs('#uc-show-category')) qs('#uc-show-category').checked = !!settings.showCategoryToAll;
  if (qs('#uc-allow-skip'))    qs('#uc-allow-skip').checked    = !!settings.allowSkipClue;
  if (qs('#uc-reveal-role'))   qs('#uc-reveal-role').checked   = !!settings.revealRoleOnElim;

  // Max rounds
  if (qs('#uc-max-rounds')) qs('#uc-max-rounds').value = settings.maxRounds ?? 0;
}

// ─────────────────────────────────────────────
// PHASE HEADER & TIMER
// ─────────────────────────────────────────────
function renderUcPhaseHeader(phase, round) {
  const info = UC_PHASE_LABELS[phase] || { label: phase, cls: '' };
  const badge = qs('#uc-phase-badge');
  if (badge) {
    badge.textContent = info.label;
    badge.className   = `game-phase-badge ${info.cls}`;
  }
  const roundEl = qs('#uc-round-label');
  if (roundEl) roundEl.textContent = `Round ${round || 1}`;
}

function startUcTimer(endTime) {
  stopUcTimer();
  const fill  = qs('#uc-timer-ring-fill');
  const label = qs('#uc-timer-value');
  if (!endTime) {
    if (label) label.textContent = '--';
    if (fill)  fill.style.strokeDashoffset = 0;
    return;
  }
  const totalMs = endTime - Date.now();
  UCState.timerInterval = setInterval(() => {
    const remaining = Math.max(0, endTime - Date.now());
    const sec = Math.ceil(remaining / 1000);
    if (label) label.textContent = sec;
    const ratio = totalMs > 0 ? remaining / totalMs : 0;
    if (fill) {
      fill.style.strokeDashoffset = CIRCUMFERENCE * (1 - ratio);
      fill.classList.toggle('urgent', sec <= 10);
    }
    if (remaining <= 0) stopUcTimer();
  }, 250);
}

function stopUcTimer() {
  if (UCState.timerInterval) { clearInterval(UCState.timerInterval); UCState.timerInterval = null; }
}

function startUcClueTimer(endTime) {
  stopUcClueTimer();
  // Reuse the same SVG timer
  startUcTimer(endTime);
}

function stopUcClueTimer() {
  // Same as stopUcTimer for now — they share the visual
}

function startUcGuessCountdown(deadline) {
  const timerEl = qs('#uc-timer-guess') || (() => {
    const el = document.createElement('p');
    el.id = 'uc-timer-guess';
    el.className = 'uc-timer-guess';
    qs('#uc-guess-area')?.appendChild(el);
    return el;
  })();
  const tick = () => {
    const remaining = Math.max(0, deadline - Date.now());
    timerEl.textContent = `${Math.ceil(remaining / 1000)}s remaining`;
    if (remaining > 0) setTimeout(tick, 500);
  };
  tick();
}

// ─────────────────────────────────────────────
// WORD PILL
// ─────────────────────────────────────────────
function renderUcWordPill(role, word) {
  const pill  = qs('#uc-word-pill');
  const value = qs('#uc-word-value');
  if (!pill || !value) return;

  if (!role) { pill.style.display = 'none'; return; }
  pill.style.display = '';

  if (role === 'blank') {
    value.textContent = '???';
    value.className   = 'uc-word-pill-value blank-word';
  } else if (role === 'undercover') {
    value.textContent = word || '???';
    value.className   = 'uc-word-pill-value undercover-word';
  } else {
    value.textContent = word || '???';
    value.className   = 'uc-word-pill-value';
  }
}

// ─────────────────────────────────────────────
// WORD REVEAL MODAL (private)
// ─────────────────────────────────────────────
function showWordRevealModal(state) {
  const { myRole, myRoleMeta, categoryLabel } = state;
  const word   = UCState.myWord;
  const isBlank = myRole === 'blank';
  const isUC    = myRole === 'undercover';

  const content = qs('#modal-content');
  if (!content) return;

  content.innerHTML = `
    <span class="modal-role-emoji">${myRoleMeta?.emoji || '❓'}</span>
    <span class="modal-role-name" style="color:var(--uc-${isBlank ? 'blank' : isUC ? 'undercover' : 'civilian'}-color)">
      ${escHtml(myRoleMeta?.label || myRole)}
    </span>
    ${isBlank
      ? `<p class="modal-role-desc">You have <strong>no word</strong>. Listen carefully to everyone's clues, figure out what they're describing, and blend in.</p>`
      : `<div style="margin:12px 0;padding:16px 24px;background:var(--bg-raised);border-radius:var(--radius-lg);border:1px solid var(--border-light)">
           <p style="font-size:0.72rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:.1em;margin-bottom:6px">Your Secret Word</p>
           <p style="font-family:var(--font-display);font-size:1.6rem;font-weight:700;color:var(--text-primary)">${escHtml(word || '???')}</p>
           ${categoryLabel ? `<p style="font-size:0.78rem;color:var(--text-muted);margin-top:4px">Category: ${escHtml(categoryLabel)}</p>` : ''}
         </div>
         <p class="modal-role-desc">${escHtml(myRoleMeta?.description || '')}</p>`
    }
    ${isUC ? `<p style="margin-top:8px;font-size:0.82rem;color:var(--uc-undercover-color)">⚠️ Your word is <em>different</em> from the civilians'. Blend in!</p>` : ''}
  `;

  const overlay = qs('#modal-overlay');
  if (overlay) overlay.classList.remove('hidden');
}

// ─────────────────────────────────────────────
// PHASE PANELS
// ─────────────────────────────────────────────
function renderUcPhasePanel(phase, state) {
  renderUcPlayerList(state?.players || []);

  switch (phase) {
    case 'uc_word_reveal':
      renderWordRevealPanel(state);
      showUcPanel('uc-panel-word-reveal');
      break;
    case 'uc_clue_giving':
      renderCluePanelBase(state);
      showUcPanel('uc-panel-clue-giving');
      break;
    case 'uc_discussion':
      renderDiscussionPanel(state);
      showUcPanel('uc-panel-discussion');
      break;
    case 'uc_voting':
      renderUcVotePanel(state);
      showUcPanel('uc-panel-voting');
      break;
    case 'uc_vote_result':
      showUcPanel('uc-panel-vote-result');
      break;
    case 'uc_blank_guess':
      showUcPanel('uc-panel-blank-guess');
      break;
    case 'uc_game_over':
      showUcPanel('uc-panel-game-over');
      break;
    default:
      break;
  }
  setUcChatMode(phase, state);
}

function showUcPanel(id) {
  document.querySelectorAll('#screen-uc-game .phase-panel').forEach(p => p.classList.remove('active'));
  qs(`#${id}`)?.classList.add('active');
}

// ── Word Reveal ──
function renderWordRevealPanel(state) {
  const area = qs('#uc-word-reveal-area');
  if (!area) return;
  const role = state?.myRole || UCState.myRole;
  const word = UCState.myWord;
  const isBlank = role === 'blank';
  const isUC    = role === 'undercover';

  const cardCls = isBlank ? 'blank-card' : isUC ? 'undercover-card' : 'civilian-card';
  const roleMeta = state?.myRoleMeta || UCState.myRoleMeta || {};

  area.innerHTML = `
    <div class="uc-word-card ${cardCls}">
      <span class="wc-role-emoji">${roleMeta.emoji || '❓'}</span>
      <span class="wc-role-name">${escHtml(roleMeta.label || role)}</span>
      <div class="wc-word">${isBlank ? '???' : escHtml(word || '???')}</div>
      <p class="wc-hint">${isBlank
        ? 'You have no word. Listen to everyone\'s clues and figure out the theme.'
        : isUC
          ? 'Your word is <em>different</em> from civilians. Blend in carefully!'
          : 'Give a clue that hints at your word without saying it directly.'
      }</p>
    </div>
    ${state?.categoryLabel ? `<span class="uc-category-badge">📂 ${escHtml(state.categoryLabel)}</span>` : ''}
  `;
}

// ── Clue Panel ──
function renderCluePanelBase(state) {
  if (!state) return;
  const clues     = state.clues || [];
  const currentId = state.currentClueTurnId;
  const players   = state.players || [];
  const alivePls  = players.filter(p => p.alive);
  const isMyTurn  = currentId === UCState.playerId;
  const isMeDead  = players.find(p => p.id === UCState.playerId)?.alive === false;

  // Build clue board
  buildClueBoard(state, clues, alivePls, currentId);

  // Input area
  const inputArea = qs('#uc-clue-input-area');
  if (!inputArea) return;

  if (isMeDead) {
    inputArea.innerHTML = `<p style="color:var(--text-muted);font-size:0.9rem">You are eliminated — watching the clues.</p>`;
  } else if (UCState.clueSubmitted) {
    inputArea.innerHTML = `<div class="uc-clue-submitted">✅ Clue submitted! Waiting for others…</div>`;
  } else if (isMyTurn) {
    const allowSkip = state.settings?.allowSkipClue !== false;
    inputArea.innerHTML = `
      <div class="uc-clue-my-turn">
        <h3>🎤 It's your turn!</h3>
        <p>Give <strong>one word or short phrase</strong> as a clue. Don't say your word directly.</p>
        <div class="uc-clue-form">
          <input type="text" id="uc-clue-field" class="uc-input" placeholder="Your clue…" maxlength="60" autocomplete="off" />
          <button class="btn btn-primary" id="uc-btn-submit-clue">Submit</button>
          ${allowSkip ? '<button class="btn btn-ghost" id="uc-btn-skip-clue">Skip</button>' : ''}
        </div>
      </div>
    `;
    qs('#uc-btn-submit-clue')?.addEventListener('click', () => {
      const val = (qs('#uc-clue-field')?.value || '').trim();
      if (!val) { toast('Please enter a clue.', 'error'); return; }
      getSocket().emit('uc_submit_clue', { roomCode: UCState.roomCode, clue: val });
      UCState.clueSubmitted = true;
      inputArea.innerHTML = `<div class="uc-clue-submitted">✅ Clue submitted! Waiting for others…</div>`;
    });
    qs('#uc-clue-field')?.addEventListener('keydown', e => {
      if (e.key === 'Enter') qs('#uc-btn-submit-clue')?.click();
    });
    qs('#uc-btn-skip-clue')?.addEventListener('click', () => {
      getSocket().emit('uc_skip_clue', { roomCode: UCState.roomCode });
      UCState.clueSubmitted = true;
      inputArea.innerHTML = `<div class="uc-clue-submitted">⏭ Clue skipped.</div>`;
    });
    setTimeout(() => qs('#uc-clue-field')?.focus(), 100);
  } else {
    const currentPlayer = players.find(p => p.id === currentId);
    inputArea.innerHTML = currentPlayer
      ? `<div class="uc-clue-waiting"><div class="spinner"></div><span>Waiting for <strong>${escHtml(currentPlayer.name)}</strong> to give their clue…</span></div>`
      : `<div class="uc-clue-waiting"><div class="spinner"></div><span>Waiting…</span></div>`;
  }

  // Host controls
  const hostCtrl = qs('#uc-host-controls');
  if (hostCtrl) hostCtrl.classList.toggle('hidden', !UCState.isHost);
}

function buildClueBoard(state, clues, alivePlayers, currentId) {
  const board = qs('#uc-clue-board');
  if (!board) return;
  board.innerHTML = `<h4>💬 Clues so far — Round ${state?.round || 1}</h4>`;

  // Show a row for every alive player in clue order
  const clueOrder = state?.players?.filter(p => p.alive)?.map(p => p.id) || [];

  alivePlayers.forEach((p, idx) => {
    const clueEntry = clues.find(c => c.playerId === p.id);
    const isCurrent = p.id === currentId && !clueEntry;
    const isMe      = p.id === UCState.playerId;

    const row = document.createElement('div');
    row.className = `clue-entry${isCurrent ? ' is-current-turn' : ''}`;
    row.innerHTML = `
      <span class="ce-order">${idx + 1}.</span>
      <span class="ce-name">${escHtml(p.name)}${isMe ? ' (you)' : ''}</span>
      ${clueEntry
        ? (clueEntry.skipped
          ? `<span class="ce-skip">— passed —</span>`
          : `<span class="ce-clue">"${escHtml(clueEntry.clue)}"</span>`)
        : isCurrent
          ? `<span class="ce-waiting">giving clue…</span>`
          : `<span class="ce-waiting" style="opacity:.4">waiting…</span>`
      }
    `;
    board.appendChild(row);
  });
}

function renderClueTurnUpdate(data) {
  if (!UCState.gameState) return;
  UCState.gameState.currentClueTurnId = data.currentPlayerId;
  UCState.gameState.clues             = data.clues;
  renderCluePanelBase(UCState.gameState);
}

function appendClueEntry(entry) {
  // Just refresh the board from state
  if (UCState.gameState) {
    if (!UCState.gameState.clues) UCState.gameState.clues = [];
    // Update if exists, push if new
    const idx = UCState.gameState.clues.findIndex(c => c.playerId === entry.playerId);
    if (idx >= 0) UCState.gameState.clues[idx] = entry;
    else UCState.gameState.clues.push(entry);

    if (UCState.phase === 'uc_clue_giving') {
      renderCluePanelBase(UCState.gameState);
    }
  }

  // Also update discussion board
  if (UCState.phase === 'uc_discussion') renderDiscussionPanel(UCState.gameState);

  addUcSystemChat(
    entry.skipped
      ? `${escHtml(entry.playerName)} passed their clue.`
      : `${escHtml(entry.playerName)}: "${escHtml(entry.clue)}"`
  );
}

// ── Discussion Panel ──
function renderDiscussionPanel(state) {
  const board = qs('#uc-discussion-clues');
  if (!board || !state) return;
  const clues   = state.clues || [];
  const players = state.players || [];

  board.innerHTML = `<h4>📋 All Clues — Round ${state.round || 1}</h4>`;
  clues.forEach((c, i) => {
    const row = document.createElement('div');
    row.className = 'clue-entry';
    row.innerHTML = `
      <span class="ce-order">${i + 1}.</span>
      <span class="ce-name">${escHtml(c.playerName)}</span>
      ${c.skipped
        ? `<span class="ce-skip">— passed —</span>`
        : `<span class="ce-clue">"${escHtml(c.clue)}"</span>`
      }
    `;
    board.appendChild(row);
  });

  if (clues.length === 0) {
    board.insertAdjacentHTML('beforeend', '<p style="color:var(--text-muted);font-size:.85rem">No clues given yet.</p>');
  }

  const hostBtn = qs('#uc-host-vote-btn');
  if (hostBtn) hostBtn.classList.toggle('hidden', !UCState.isHost);
}

// ── Voting Panel ──
function renderUcVotePanel(state) {
  const area    = qs('#uc-vote-action-area');
  const tally   = qs('#uc-vote-tally-bar');
  if (!area || !state) return;
  area.innerHTML  = '';

  const players = state.players || [];
  const me      = players.find(p => p.id === UCState.playerId);
  const canVote = me?.alive;

  if (!canVote) {
    area.innerHTML = `<p style="color:var(--text-muted);font-size:.9rem">You are eliminated — watching the vote.</p>`;
    qs('#uc-btn-vote-skip')?.setAttribute('style', 'display:none');
    return;
  }

  qs('#uc-btn-vote-skip')?.removeAttribute('style');
  const targets = players.filter(p => p.alive && p.id !== UCState.playerId);

  targets.forEach((p, i) => {
    const btn = document.createElement('button');
    btn.className   = 'vote-btn';
    btn.dataset.targetId = p.id;
    if (UCState.myVote === p.id) btn.classList.add('voted');
    btn.innerHTML = `
      <span class="v-avatar">${PLAYER_AVATARS[i % PLAYER_AVATARS.length]}</span>
      <span>${escHtml(p.name)}</span>
      <span class="v-count" style="display:none">0</span>
    `;
    btn.addEventListener('click', () => submitUcVote(p.id));
    area.appendChild(btn);
  });

  // Render tally if available
  if (state.voteTally) renderUcVoteTally(state.voteTally);
}

function renderUcVoteTally(tally) {
  const bar = qs('#uc-vote-tally-bar');
  if (!bar || !tally) return;
  bar.innerHTML = `<h4>🗳️ Current Votes</h4>`;
  const total = tally.totalAlive || 1;
  const entries = Object.values(tally.tally || {}).sort((a,b) => b.count - a.count);

  entries.forEach(entry => {
    const pct = Math.round(entry.count / total * 100);
    const row = document.createElement('div');
    row.className = 'tally-row';
    row.innerHTML = `
      <span class="tally-name">${escHtml(entry.targetName || '?')}</span>
      <div class="tally-bar-fill"><div class="tally-bar-inner" style="width:${pct}%"></div></div>
      <span class="tally-count">${entry.count}</span>
    `;
    bar.appendChild(row);
  });

  if (tally.skipCount > 0) {
    const row = document.createElement('div');
    row.className = 'tally-row';
    row.style.color = 'var(--text-muted)';
    row.innerHTML = `
      <span class="tally-name">Skip</span>
      <div class="tally-bar-fill"><div class="tally-bar-inner" style="width:${Math.round(tally.skipCount/total*100)}%;background:var(--text-muted)"></div></div>
      <span class="tally-count">${tally.skipCount}</span>
    `;
    bar.appendChild(row);
  }

  const summary = document.createElement('p');
  summary.style.cssText = 'font-size:.78rem;color:var(--text-muted);margin-top:6px';
  summary.textContent = `${tally.totalVoted} of ${tally.totalAlive} players voted.`;
  bar.appendChild(summary);
}

function updateUcVoteButtons(tally) {
  qs('#uc-vote-action-area')?.querySelectorAll('.vote-btn').forEach(btn => {
    const entry  = tally?.tally?.[btn.dataset.targetId];
    const countEl = btn.querySelector('.v-count');
    if (countEl && entry) { countEl.style.display = ''; countEl.textContent = entry.count; }
    else if (countEl) countEl.style.display = 'none';
  });
}

// ── Vote Result ──
function renderUcVoteResult(result) {
  const area = qs('#uc-vote-result-content');
  if (!area) return;

  if (result.eliminated) {
    const p = result.eliminated;
    const roleLabel = p.roleMeta?.label || p.role || '';
    const roleEmoji = p.roleMeta?.emoji || '❓';
    area.innerHTML = `
      <div class="vote-result-card uc-eliminated">
        <span class="reveal-icon">${roleEmoji}</span>
        <h3>${escHtml(p.name)} was voted out!</h3>
        ${p.role ? `<p class="vote-result-role">They were the ${escHtml(roleLabel)}</p>` : ''}
        <p style="margin-top:10px;color:var(--text-secondary);font-size:.88rem">${escHtml(result.message)}</p>
      </div>
    `;
  } else {
    area.innerHTML = `
      <div class="vote-result-card uc-no-elim">
        <span class="reveal-icon">${result.isTie ? '⚖️' : '🗳️'}</span>
        <h3>${result.isTie ? 'It\'s a tie!' : 'No elimination'}</h3>
        <p style="margin-top:10px;color:var(--text-secondary);font-size:.88rem">${escHtml(result.message)}</p>
      </div>
    `;
  }
}

// ── Blank Guess Panel ──
function renderUcBlankGuessPanel(guesserName, isUndercover, isMe, deadline) {
  const title    = qs('#uc-guess-title');
  const subtitle = qs('#uc-guess-subtitle');
  const waiting  = qs('#uc-guess-waiting');
  const input    = qs('#uc-guess-input');
  const waitText = qs('#uc-guess-waiting-text');
  const promptTx = qs('#uc-guess-prompt-text');

  const role = isUndercover ? 'Undercover' : 'Blank';
  if (title) title.textContent = isUndercover ? '🕵️ Undercover\'s Last Chance' : '❓ Blank\'s Last Chance';
  if (subtitle) subtitle.textContent = `${escHtml(guesserName)} has 30 seconds to guess the civilian word.`;
  if (promptTx) promptTx.textContent = `What is the civilian word? (${role} guessing)`;

  if (isMe) {
    waiting?.classList.add('hidden');
    input?.classList.remove('hidden');
    setTimeout(() => qs('#uc-guess-field')?.focus(), 100);
  } else {
    waiting?.classList.remove('hidden');
    input?.classList.add('hidden');
    if (waitText) waitText.textContent = `Waiting for ${escHtml(guesserName)}'s guess…`;
  }
}

// ── Game Over ──
function renderUcGameOver(data) {
  const { winningTeam, message, players, wordA, wordB, categoryLabel, log } = data;
  const myTeam = UCState.myRoleMeta?.team || 'civilian';
  const iWon   = myTeam === winningTeam;

  const area = qs('#uc-game-over-content');
  if (!area) return;
  area.innerHTML = '';

  // Banner
  const bannerCls = {
    civilian:   'civilian-wins',
    undercover: 'undercover-wins',
    blank:      'blank-wins',
  }[winningTeam] || 'civilian-wins';

  const bannerEmoji = { civilian:'👤', undercover:'🕵️', blank:'❓' }[winningTeam] || '🏆';

  const banner = document.createElement('div');
  banner.className = `game-over-banner ${bannerCls}`;
  banner.innerHTML = `
    <span class="go-icon">${bannerEmoji}</span>
    <h2>${winningTeam.charAt(0).toUpperCase() + winningTeam.slice(1)} Wins!</h2>
    <p>${escHtml(message)}</p>
    ${iWon
      ? `<p style="margin-top:10px;font-weight:600">🎉 You won!</p>`
      : `<p style="margin-top:10px;color:var(--text-muted)">Better luck next time.</p>`}
  `;
  area.appendChild(banner);

  // Word reveal
  const wordReveal = document.createElement('div');
  wordReveal.className = 'uc-word-reveal-final';
  wordReveal.innerHTML = `
    <h4>The Words Were</h4>
    <div class="uc-final-words">
      <div class="uc-final-word-item civilian">
        <div class="ufw-label">👤 Civilian Word</div>
        <div class="ufw-word">${escHtml(wordA)}</div>
      </div>
      <div class="uc-final-word-item undercover">
        <div class="ufw-label">🕵️ Undercover Word</div>
        <div class="ufw-word">${escHtml(wordB)}</div>
      </div>
    </div>
    ${categoryLabel ? `<p style="font-size:.78rem;color:var(--text-muted);margin-top:8px">Category: ${escHtml(categoryLabel)}</p>` : ''}
  `;
  area.appendChild(wordReveal);

  // Players grid
  const gridTitle = document.createElement('h3');
  gridTitle.style.cssText = 'font-family:var(--font-display);font-size:1rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:.08em;';
  gridTitle.textContent = 'Final Roles';
  area.appendChild(gridTitle);

  const grid = document.createElement('div');
  grid.className = 'final-players-grid';
  players.forEach(p => {
    const isWinner = p.team === winningTeam;
    const card = document.createElement('div');
    card.className = `final-player-card ${isWinner ? 'is-winner' : 'is-loser'}`;
    card.innerHTML = `
      <span class="fp-emoji">${p.roleMeta?.emoji || '❓'}</span>
      <span class="fp-name" title="${escHtml(p.name)}">${escHtml(p.name)}</span>
      <span class="fp-role">${escHtml(p.roleMeta?.label || p.role)}</span>
      <span class="fp-alive ${p.alive ? 'alive' : 'dead'}">${p.alive ? '● Alive' : '● Eliminated'}</span>
    `;
    grid.appendChild(card);
  });
  area.appendChild(grid);

  // Actions
  const actions = document.createElement('div');
  actions.className = 'game-over-actions';
  actions.innerHTML = `
    <button class="btn btn-primary" id="uc-btn-play-again">Play Again</button>
    <button class="btn btn-ghost"   id="uc-btn-go-home">Home</button>
  `;
  area.appendChild(actions);

  qs('#uc-btn-play-again')?.addEventListener('click', () => { clearUcSession(); showScreen('home'); });
  qs('#uc-btn-go-home')?.addEventListener('click',   () => { clearUcSession(); showScreen('home'); });

  // Event log
  if (log) renderUcEventLog(log);

  stopUcTimer();
  stopUcClueTimer();
  const timerVal = qs('#uc-timer-value');
  if (timerVal) timerVal.textContent = '--';
}

// ─────────────────────────────────────────────
// PLAYER LIST
// ─────────────────────────────────────────────
function renderUcPlayerList(players) {
  if (!players) return;
  const list = qs('#uc-game-player-list');
  if (!list) return;
  list.innerHTML = '';

  const alive = players.filter(p => p.alive).length;
  const aliveEl = qs('#uc-alive-count');
  if (aliveEl) aliveEl.textContent = `${alive} alive`;

  players.forEach((p, i) => {
    const isYou      = p.id === UCState.playerId;
    const roleReveal = p.role ? `uc-${p.role}-reveal` : '';
    const li = document.createElement('li');
    li.className = [
      'game-player-item',
      isYou          ? 'is-you'  : '',
      !p.alive        ? 'is-dead' : '',
      roleReveal,
    ].filter(Boolean).join(' ');
    li.dataset.playerId = p.id;

    const roleTag = p.role
      ? `<span class="gp-role-tag">${p.roleMeta?.emoji || ''} ${p.roleMeta?.label || ''}</span>`
      : '';
    const clueGiven = p.hasGivenClue
      ? `<span style="font-size:.65rem;color:var(--accent-green)">✓</span>`
      : '';

    li.innerHTML = `
      <span class="gp-avatar">${p.alive ? PLAYER_AVATARS[i % PLAYER_AVATARS.length] : '💀'}</span>
      <span class="gp-name">${escHtml(p.name)}</span>
      ${roleTag}
      ${clueGiven}
      ${isYou ? '<span class="gp-you-dot"></span>' : ''}
    `;
    list.appendChild(li);
  });
}

// ─────────────────────────────────────────────
// CHAT
// ─────────────────────────────────────────────
function setUcChatMode(phase, state) {
  const label  = qs('#uc-chat-mode-label');
  const input  = qs('#uc-chat-input');
  const btn    = qs('#uc-btn-chat-send');
  const isAlive = state?.players?.find(p => p.id === UCState.playerId)?.alive ?? true;

  // During clue giving: chat is allowed for discussion but we label it
  if (phase === 'uc_clue_giving') {
    if (label) label.textContent = '🤫 Listening…';
  } else if (!isAlive) {
    if (label) label.textContent = '👻 Ghost Chat';
    if (input) input.placeholder = 'Ghost chat (dead only)…';
  } else {
    if (label) label.textContent = '';
    if (input) input.placeholder = 'Type a message…';
  }
  if (input) input.disabled = false;
  if (btn)   btn.disabled   = false;
}

function addUcChatMessage(senderName, message, timestamp, isDeadChat) {
  const container = qs('#uc-chat-messages');
  if (!container) return;
  const msg = document.createElement('div');
  msg.className = `chat-msg${isDeadChat ? ' dead-chat' : ''}`;
  const time = timestamp ? formatTime(new Date(timestamp)) : '';
  msg.innerHTML = `
    <span class="chat-msg-sender">${escHtml(senderName)}</span>
    <span class="chat-msg-time">${time}</span>
    <br/>${escHtml(message)}
  `;
  container.appendChild(msg);
  container.scrollTop = container.scrollHeight;
}

function addUcSystemChat(message) {
  const container = qs('#uc-chat-messages');
  if (!container) return;
  const msg = document.createElement('div');
  msg.className = 'chat-msg system-msg';
  msg.textContent = message;
  container.appendChild(msg);
  container.scrollTop = container.scrollHeight;
}

// ─────────────────────────────────────────────
// EVENT LOG
// ─────────────────────────────────────────────
function renderUcEventLog(log) {
  const list = qs('#uc-event-log-list');
  if (!list) return;
  list.innerHTML = '';
  log.forEach(entry => {
    const li = document.createElement('li');
    li.className = 'log-item';
    li.innerHTML = `<span class="log-round">R${entry.round}</span>${escHtml(entry.message)}`;
    list.appendChild(li);
  });
}

// ─────────────────────────────────────────────
// SESSION PERSISTENCE
// ─────────────────────────────────────────────
function saveUcSession() {
  try {
    localStorage.setItem(UC_SESSION_KEY, JSON.stringify({
      playerId:   UCState.playerId,
      playerName: UCState.playerName,
      roomCode:   UCState.roomCode,
    }));
  } catch (_) {}
}

function loadUcSession() {
  try {
    const raw = localStorage.getItem(UC_SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (_) { return null; }
}

function clearUcSession() {
  UCState.playerId = UCState.playerName = UCState.roomCode = null;
  UCState.isHost = false; UCState.gameState = null;
  UCState.myRole = UCState.myRoleMeta = UCState.myWord = null;
  UCState.clueSubmitted = false; UCState.myVote = null;
  try { localStorage.removeItem(UC_SESSION_KEY); } catch (_) {}
}

function attemptUcReconnect() {
  const session = loadUcSession();
  if (!session?.playerId || !session?.roomCode) return;
  UCState.playerId   = session.playerId;
  UCState.playerName = session.playerName;
  UCState.roomCode   = session.roomCode;
  // Re-join will be triggered by socket 'connect' event in client.js
  // But for UC we need to emit separately; piggyback on connect event
  const doReconnect = () => {
    const s = getSocket();
    if (!s?.connected) { setTimeout(doReconnect, 200); return; }
    s.emit('uc_join_room', {
      roomCode:   session.roomCode,
      playerName: session.playerName,
      playerId:   session.playerId,
    });
  };
  setTimeout(doReconnect, 150);
}

// ─────────────────────────────────────────────
// UTILITIES
// ─────────────────────────────────────────────

/** Get the shared Socket.io socket (initialised by client.js) */
function getSocket() {
  return typeof State !== 'undefined' ? State.socket : null;
}

function ucSanitizeName(name) {
  return String(name || '').trim().replace(/[<>]/g, '').slice(0, 20);
}

function ucValidateName(name) {
  if (!name || name.length < 1 || name.length > 20) {
    showUcHomeError('Name must be 1–20 characters.');
    return false;
  }
  return true;
}

function showUcHomeError(msg) {
  const el = qs('#uc-home-error');
  if (!el) return;
  el.textContent = msg;
  el.classList.remove('hidden');
}

function clearUcHomeError() {
  const el = qs('#uc-home-error');
  if (el) { el.textContent = ''; el.classList.add('hidden'); }
}
