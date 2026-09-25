/**
 * Mafia Game — Frontend Client
 *
 * Handles:
 *   - Socket.io connection & all server events
 *   - Screen/phase rendering
 *   - Night actions (role-specific UI)
 *   - Day voting with live tally
 *   - Phase countdown timer
 *   - Chat (public, mafia-only, dead)
 *   - Role reveal modal
 *   - Reconnection with localStorage session restore
 *   - Toast notifications
 *   - Event log
 */

// ═══════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════
const State = {
  socket: null,
  playerId: null,
  playerName: null,
  roomCode: null,
  isHost: false,
  gameState: null,       // full state snapshot from server
  phase: 'lobby',
  myRole: null,
  myRoleMeta: null,
  nightActionSubmitted: false,
  myDayVote: null,       // targetId or 'skip'
  timerInterval: null,
  phaseEndTime: null,
};

// ═══════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════
const PHASE_LABELS = {
  lobby:       { label: 'Lobby',      cls: '' },
  night:       { label: 'Night',      cls: 'phase-night' },
  day_reveal:  { label: 'Dawn',       cls: 'phase-day' },
  day_discuss: { label: 'Discussion', cls: 'phase-day' },
  day_vote:    { label: 'Vote',       cls: 'phase-vote' },
  vote_result: { label: 'Result',     cls: 'phase-vote' },
  game_over:   { label: 'Game Over',  cls: 'phase-gameover' },
};

const PLAYER_AVATARS = ['🧑', '👩', '👨', '🧔', '👱', '🧕', '👲', '🧓', '👴', '👵', '🧑‍🦰', '🧑‍🦱'];

const CIRCUMFERENCE = 2 * Math.PI * 18; // r=18 for SVG timer ring

// ═══════════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════════
document.addEventListener('DOMContentLoaded', () => {
  generateStars();
  bindHomeEvents();
  bindLobbyEvents();
  bindGameEvents();
  initSocket();
  attemptReconnect();
});

// ═══════════════════════════════════════════════
// SOCKET SETUP
// ═══════════════════════════════════════════════
function initSocket() {
  State.socket = io({
    reconnection: true,
    reconnectionAttempts: 10,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
  });

  const s = State.socket;

  // ── Connection lifecycle ──
  s.on('connect', () => {
    hideConnectionBar();
    if (State.roomCode && State.playerId) {
      // Re-join socket room after reconnect
      s.emit('join_room', {
        roomCode: State.roomCode,
        playerName: State.playerName,
        playerId: State.playerId,
      });
    }
  });

  s.on('disconnect', (reason) => {
    showConnectionBar('⚠️ Connection lost. Reconnecting…');
    stopTimer();
  });

  s.io.on('reconnect', () => {
    showConnectionBar('✅ Reconnected!', true);
    setTimeout(hideConnectionBar, 2500);
  });

  s.io.on('reconnect_failed', () => {
    showConnectionBar('❌ Could not reconnect. Please refresh the page.');
  });

  // ── Room events ──
  s.on('room_created', ({ roomCode, playerId, playerName }) => {
    State.playerId = playerId;
    State.playerName = playerName;
    State.roomCode = roomCode;
    State.isHost = true;
    saveSession();
    showScreen('lobby');
    setLobbyRoomCode(roomCode);
    toast(`Room ${roomCode} created!`, 'success');
  });

  s.on('room_joined', ({ roomCode, playerId, playerName, isHost, state }) => {
    State.playerId = playerId;
    State.playerName = playerName;
    State.roomCode = roomCode;
    State.isHost = isHost;
    saveSession();
    showScreen('lobby');
    setLobbyRoomCode(roomCode);
    renderLobby(state);
    toast(`Joined room ${roomCode}`, 'success');
  });

  s.on('lobby_update', (state) => {
    // Update isHost in case host changed
    const me = (state.players || []).find(p => p.id === State.playerId);
    if (me) State.isHost = (state.hostId === State.playerId);
    if (state.roomCode) setLobbyRoomCode(state.roomCode);
    renderLobby(state);
  });

  // ── Game start ──
  s.on('game_started', ({ state }) => {
    State.gameState = state;
    State.myRole = state.myRole;
    State.myRoleMeta = state.myRoleMeta;
    State.phase = state.phase;
    State.phaseEndTime = state.phaseEndTime;
    State.nightActionSubmitted = false;
    State.myDayVote = null;
    showScreen('game');
    // Render the full game board with the received state
    updatePhaseHeader(state.phase, state.round);
    renderPlayerList(state.players);
    renderMyRolePill(state.myRole);
    renderPhasePanel(state.phase, state.players.filter(p => p.alive));
    if (state.phaseEndTime) startTimer(state.phaseEndTime);
    showRoleModal(state);
  });

  // ── Phase transitions ──
  s.on('phase_change', (data) => {
    State.phase = data.phase;
    State.phaseEndTime = data.phaseEndTime;
    State.nightActionSubmitted = false;
    State.myDayVote = null;

    updatePhaseHeader(data.phase, data.round);
    startTimer(data.phaseEndTime);

    // Always request fresh state on phase change so role-sensitive
    // rendering (night action targets, vote buttons) uses up-to-date data.
    // Render immediately with what we have (alivePlayers from payload),
    // then re-render once state_snapshot arrives.
    renderPhasePanel(data.phase, data.alivePlayers || []);
    s.emit('request_state', { roomCode: State.roomCode });
  });

  // ── Full state snapshot (response to request_state or reconnect) ──
  s.on('state_snapshot', ({ state }) => {
    State.gameState = state;
    State.phase = state.phase;
    State.myRole = state.myRole;
    State.myRoleMeta = state.myRoleMeta;
    State.phaseEndTime = state.phaseEndTime;

    if (state.phase === 'lobby') {
      showScreen('lobby');
      setLobbyRoomCode(state.roomCode || State.roomCode || '');
      renderLobby(state);
    } else {
      showScreen('game');
      updatePhaseHeader(state.phase, state.round);
      renderPlayerList(state.players);
      renderMyRolePill(state.myRole);
      // Only re-render the phase panel on snapshot if we're not
      // in a "result" phase (which already has its own rendering).
      const resultPhases = ['day_reveal', 'vote_result', 'game_over'];
      if (!resultPhases.includes(state.phase)) {
        renderPhasePanel(state.phase, state.players.filter(p => p.alive));
      }
      if (state.phaseEndTime) {
        startTimer(state.phaseEndTime);
      }
      if (state.voteTally && state.phase === 'day_vote') {
        renderVoteTally(state.voteTally);
        updateVoteButtons(state.voteTally);
      }
      if (state.phase === 'game_over' && state.eventLog) {
        renderEventLog(state.eventLog);
      }
    }
  });

  // ── Night result ──
  s.on('night_result', (data) => {
    renderNightReveal(data);
  });

  // ── Detective private result ──
  s.on('detective_result', ({ targetName, isMafia }) => {
    const msg = isMafia
      ? `🔍 Your investigation: ${targetName} IS a Mafia member!`
      : `🔍 Your investigation: ${targetName} is NOT Mafia (innocent).`;
    toast(msg, isMafia ? 'error' : 'success', 6000);
    addSystemChat(msg);
  });

  // ── Vote updates ──
  s.on('vote_update', (tally) => {
    renderVoteTally(tally);
    updateVoteButtons(tally);
  });

  // ── Vote result ──
  s.on('vote_result', (result) => {
    renderVoteResult(result);
    // Update player list (someone may have been eliminated)
    if (State.gameState) {
      s.emit('request_state', { roomCode: State.roomCode });
    }
  });

  // ── Game over ──
  s.on('game_over', (data) => {
    State.phase = 'game_over';
    stopTimer();
    updatePhaseHeader('game_over', State.gameState?.round || 0);
    renderGameOver(data);
    showPanel('panel-game-over');
  });

  // ── Action confirmed ──
  s.on('action_confirmed', ({ message }) => {
    toast(message, 'success');
  });

  // ── Mafia-specific: teammate vote during night ──
  s.on('mafia_vote_update', ({ voterName, targetName }) => {
    addSystemChat(`🔫 ${voterName} is voting to eliminate ${targetName}.`, true);
  });

  // ── Chat ──
  s.on('chat_message', ({ senderName, message, timestamp, isMafiaChat, isDeadChat }) => {
    addChatMessage(senderName, message, timestamp, isMafiaChat, isDeadChat);
  });

  // ── Player left ──
  s.on('player_left', ({ playerName, isDisconnect }) => {
    const reason = isDisconnect ? 'disconnected' : 'left the game';
    toast(`${playerName} ${reason}.`, 'warning');
    addSystemChat(`${playerName} ${reason}.`);
  });

  // ── Error ──
  s.on('error', ({ message }) => {
    toast(message, 'error');
    clearHomeError();
    showHomeError(message);
  });

  // ── Room closed ──
  s.on('room_closed', ({ reason }) => {
    clearSession();
    toast(reason || 'Room was closed.', 'warning', 5000);
    setTimeout(() => showScreen('home'), 3000);
  });
}

// ═══════════════════════════════════════════════
// HOME SCREEN
// ═══════════════════════════════════════════════
function bindHomeEvents() {
  // Create room
  qs('#btn-create').addEventListener('click', () => {
    const name = qs('#create-name').value.trim();
    if (!validateName(name)) return;
    clearHomeError();
    State.socket.emit('create_room', { playerName: name });
  });

  qs('#create-name').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') qs('#btn-create').click();
  });

  // Join room
  qs('#btn-join').addEventListener('click', () => {
    const name = qs('#join-name').value.trim();
    const code = qs('#join-code').value.trim().toUpperCase();
    if (!validateName(name)) return;
    if (!code || code.length !== 6) {
      showHomeError('Please enter a 6-character room code.');
      return;
    }
    clearHomeError();
    State.socket.emit('join_room', { roomCode: code, playerName: name });
  });

  qs('#join-name').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') qs('#join-code').focus();
  });
  qs('#join-code').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') qs('#btn-join').click();
  });
  qs('#join-code').addEventListener('input', (e) => {
    e.target.value = e.target.value.toUpperCase();
  });

  // Rules toggle
  qs('#btn-rules').addEventListener('click', () => {
    const panel = qs('#rules-panel');
    const isHidden = panel.classList.contains('hidden');
    panel.classList.toggle('hidden', !isHidden);
    qs('#btn-rules').textContent = isHidden ? 'How to Play ▴' : 'How to Play ▾';
  });
}

function validateName(name) {
  if (!name || name.length < 1 || name.length > 20) {
    showHomeError('Name must be 1–20 characters.');
    return false;
  }
  return true;
}

function showHomeError(msg) {
  const el = qs('#home-error');
  el.textContent = msg;
  el.classList.remove('hidden');
}

function clearHomeError() {
  const el = qs('#home-error');
  el.textContent = '';
  el.classList.add('hidden');
}

// ═══════════════════════════════════════════════
// LOBBY SCREEN
// ═══════════════════════════════════════════════
function bindLobbyEvents() {
  // Copy room code
  qs('#btn-copy-code').addEventListener('click', () => {
    const code = qs('#lobby-room-code').textContent;
    navigator.clipboard?.writeText(code).then(() => {
      toast('Room code copied!', 'success');
    });
  });

  // Start game
  qs('#btn-start').addEventListener('click', () => {
    State.socket.emit('start_game', { roomCode: State.roomCode });
  });

  // Leave lobby
  qs('#btn-leave-lobby').addEventListener('click', () => {
    State.socket.emit('leave_room', { roomCode: State.roomCode });
    clearSession();
    showScreen('home');
  });
}

function setLobbyRoomCode(code) {
  qs('#lobby-room-code').textContent = code;
}

function renderLobby(state) {
  const { players, hostId, playerCount, minPlayers, maxPlayers, roomCode } = state;
  const count = players ? players.length : (playerCount || 0);

  qs('#lobby-player-count').textContent = `${count} / ${maxPlayers || 12} players`;

  // Player list
  const list = qs('#lobby-player-list');
  list.innerHTML = '';
  (players || []).forEach((p, i) => {
    const isYou = p.id === State.playerId;
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

  // Start button visibility
  const isHost = hostId === State.playerId;
  const canStart = isHost && count >= (minPlayers || 4);
  qs('#btn-start').disabled = !canStart;
  qs('#btn-start').style.display = isHost ? '' : 'none';
  qs('#host-note').textContent = isHost
    ? (count < (minPlayers || 4) ? `Need ${(minPlayers || 4) - count} more player${(minPlayers || 4) - count !== 1 ? 's' : ''} to start.` : 'Ready to start!')
    : `Waiting for ${(players || []).find(p => p.id === hostId)?.name || 'the host'} to start…`;

  // Role distribution preview
  renderRoleDistribution(count);

  // Lobby hint
  qs('#lobby-hint').textContent = count < (minPlayers || 4)
    ? `Waiting for players… (need at least ${minPlayers || 4})`
    : `${count} players ready — game can start!`;
}

function renderRoleDistribution(count) {
  const dist = getRoleDistribution(count);
  const container = qs('#role-distribution');
  container.innerHTML = `<h4>Role Preview</h4>`;
  const roles = [
    { key: 'mafia',     emoji: '🔫', label: 'Mafia',     color: 'var(--mafia-color)' },
    { key: 'detective', emoji: '🔍', label: 'Detective', color: 'var(--detective-color)' },
    { key: 'doctor',    emoji: '💉', label: 'Doctor',    color: 'var(--doctor-color)' },
    { key: 'villager',  emoji: '🏘️', label: 'Villager', color: 'var(--villager-color)' },
  ];
  roles.forEach(r => {
    const n = dist[r.key] || 0;
    if (n === 0) return;
    const div = document.createElement('div');
    div.className = 'role-dist-item';
    div.innerHTML = `
      <span>${r.emoji}</span>
      <span style="color:${r.color}">${r.label}</span>
      <span class="role-dist-count">${n}</span>
    `;
    container.appendChild(div);
  });
}

// Client-side role distribution mirror (matches server logic)
function getRoleDistribution(count) {
  if (count < 4) return {};
  const mafia = count <= 5 ? 1 : count <= 8 ? 2 : 3;
  const villager = Math.max(0, count - mafia - 2);
  return { mafia, detective: 1, doctor: 1, villager };
}

// ═══════════════════════════════════════════════
// GAME SCREEN — GENERAL
// ═══════════════════════════════════════════════
function bindGameEvents() {
  // Chat send
  qs('#btn-chat-send').addEventListener('click', sendChat);
  qs('#chat-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sendChat();
  });

  // Skip vote
  qs('#btn-vote-skip').addEventListener('click', () => {
    submitDayVote('skip');
  });

  // Event log toggle
  qs('#btn-toggle-log').addEventListener('click', () => {
    qs('#event-log-panel').classList.toggle('hidden');
  });

  // Modal close
  qs('#modal-close').addEventListener('click', () => {
    qs('#modal-overlay').classList.add('hidden');
  });
}

function sendChat() {
  const input = qs('#chat-input');
  const message = input.value.trim();
  if (!message) return;
  State.socket.emit('send_chat', { roomCode: State.roomCode, message });
  input.value = '';
}

// ═══════════════════════════════════════════════
// PHASE HEADER & TIMER
// ═══════════════════════════════════════════════
function updatePhaseHeader(phase, round) {
  const info = PHASE_LABELS[phase] || { label: phase, cls: '' };
  const badge = qs('#phase-badge');
  badge.textContent = info.label;
  badge.className = `game-phase-badge ${info.cls}`;
  qs('#round-label').textContent = `Round ${round || 1}`;
}

function startTimer(endTime) {
  stopTimer();
  if (!endTime) {
    qs('#timer-value').textContent = '--';
    setTimerProgress(0);
    return;
  }

  // Work out total duration from server end time
  // We don't know exact start, so we estimate from now
  State.phaseEndTime = endTime;
  const totalMs = endTime - Date.now();
  const totalSec = Math.max(0, Math.round(totalMs / 1000));

  State.timerInterval = setInterval(() => {
    const remaining = Math.max(0, endTime - Date.now());
    const remainSec = Math.ceil(remaining / 1000);
    qs('#timer-value').textContent = remainSec;

    const progress = totalMs > 0 ? remaining / totalMs : 0;
    setTimerProgress(progress);

    const fill = qs('#timer-ring-fill');
    if (remainSec <= 10) {
      fill.classList.add('urgent');
    } else {
      fill.classList.remove('urgent');
    }

    if (remaining <= 0) stopTimer();
  }, 250);
}

function stopTimer() {
  if (State.timerInterval) {
    clearInterval(State.timerInterval);
    State.timerInterval = null;
  }
}

function setTimerProgress(ratio) {
  // ratio 1 = full circle, 0 = empty
  const offset = CIRCUMFERENCE * (1 - ratio);
  qs('#timer-ring-fill').style.strokeDashoffset = offset;
}

// ═══════════════════════════════════════════════
// PLAYER LIST (game sidebar)
// ═══════════════════════════════════════════════
function renderPlayerList(players) {
  if (!players) return;
  const list = qs('#game-player-list');
  list.innerHTML = '';

  const alive = players.filter(p => p.alive).length;
  qs('#alive-count').textContent = `${alive} alive`;

  players.forEach((p, i) => {
    const isYou = p.id === State.playerId;
    const isMafia = p.role === 'mafia' && (State.myRole === 'mafia' || State.phase === 'game_over' || !p.alive);
    const li = document.createElement('li');
    li.className = [
      'game-player-item',
      isYou         ? 'is-you'          : '',
      !p.alive      ? 'is-dead'         : '',
      isMafia && p.role ? 'is-mafia-reveal' : '',
    ].filter(Boolean).join(' ');
    li.dataset.playerId = p.id;

    const roleTag = (p.role && (!p.alive || State.phase === 'game_over'))
      ? `<span class="gp-role-tag">${p.roleMeta?.emoji || ''} ${p.roleMeta?.label || ''}</span>`
      : '';

    li.innerHTML = `
      <span class="gp-avatar">${p.alive ? PLAYER_AVATARS[i % PLAYER_AVATARS.length] : '💀'}</span>
      <span class="gp-name">${escHtml(p.name)}</span>
      ${roleTag}
      ${isYou ? '<span class="gp-you-dot"></span>' : ''}
    `;
    list.appendChild(li);
  });
}

function renderMyRolePill(role) {
  if (!role) return;
  const meta = State.myRoleMeta || {};
  const pill = qs('#my-role-pill');
  pill.className = `my-role-pill role-${role}`;
  pill.textContent = `${meta.emoji || ''} ${meta.label || role}`;
}

// ═══════════════════════════════════════════════
// PHASE PANELS
// ═══════════════════════════════════════════════
function renderPhasePanel(phase, alivePlayers) {
  if (State.gameState) {
    renderPlayerList(State.gameState.players);
    renderMyRolePill(State.myRole);
  }

  switch (phase) {
    case 'night':
      renderNightPanel(alivePlayers);
      showPanel('panel-night');
      setChatMode(phase);
      break;
    case 'day_reveal':
      showPanel('panel-day-reveal');
      setChatMode(phase);
      break;
    case 'day_discuss':
      renderDiscussPanel();
      showPanel('panel-day-discuss');
      setChatMode(phase);
      break;
    case 'day_vote':
      renderVotePanel(alivePlayers);
      showPanel('panel-day-vote');
      setChatMode(phase);
      break;
    case 'vote_result':
      showPanel('panel-vote-result');
      setChatMode(phase);
      break;
    case 'game_over':
      showPanel('panel-game-over');
      setChatMode(phase);
      break;
    default:
      break;
  }
}

function showPanel(id) {
  document.querySelectorAll('.phase-panel').forEach(p => p.classList.remove('active'));
  qs(`#${id}`)?.classList.add('active');
}

function setChatMode(phase) {
  const label = qs('#chat-mode-label');
  const input = qs('#chat-input');
  const btn = qs('#btn-chat-send');
  const isAlive = State.gameState?.players?.find(p => p.id === State.playerId)?.alive ?? true;

  if (phase === 'night') {
    if (State.myRole === 'mafia') {
      label.textContent = '🔫 Mafia Only';
      input.disabled = false;
      input.placeholder = 'Chat with your Mafia…';
      btn.disabled = false;
    } else {
      label.textContent = '🔇 Silent';
      input.disabled = true;
      input.placeholder = 'Night — chat disabled';
      btn.disabled = true;
    }
  } else if (!isAlive) {
    label.textContent = '👻 Ghost Chat';
    input.disabled = false;
    input.placeholder = 'Ghost chat (dead only)…';
    btn.disabled = false;
  } else {
    label.textContent = '';
    input.disabled = false;
    input.placeholder = 'Type a message…';
    btn.disabled = false;
  }
}

// ── Night Phase ──
function renderNightPanel(alivePlayers) {
  const role = State.myRole;
  const area = qs('#night-action-area');
  const waiting = qs('#night-waiting');
  area.innerHTML = '';

  const me = State.gameState?.players?.find(p => p.id === State.playerId);
  if (!me?.alive) {
    area.innerHTML = `<div class="night-instruction"><h3>💀 You are eliminated</h3><p>Watch as the night unfolds…</p></div>`;
    waiting.classList.add('hidden');
    return;
  }

  if (State.nightActionSubmitted) {
    area.innerHTML = `<div class="action-submitted-msg">✅ Your action has been submitted. Waiting for others…</div>`;
    waiting.classList.remove('hidden');
    return;
  }

  const players = State.gameState?.players || [];

  if (role === 'mafia') {
    renderMafiaTeam(players);
    const targets = players.filter(p => p.alive && p.role !== 'mafia' && p.id !== State.playerId);
    area.insertAdjacentHTML('beforeend', `
      <div class="night-instruction">
        <h3>🔫 Choose a Target</h3>
        <p>Secretly vote to eliminate a villager. All Mafia must agree before morning.</p>
      </div>
    `);
    renderTargetGrid(area, targets, (targetId) => {
      State.socket.emit('night_action', { roomCode: State.roomCode, targetId });
      State.nightActionSubmitted = true;
      renderNightPanel(alivePlayers);
    });
    waiting.classList.add('hidden');

  } else if (role === 'doctor') {
    const targets = players.filter(p => p.alive);
    const selfSaveUsed = State.gameState?.doctorSelfSaveUsed;
    area.innerHTML = `
      <div class="night-instruction">
        <h3>💉 Choose Someone to Protect</h3>
        <p>Pick one player to save from the Mafia tonight.${selfSaveUsed ? ' <em>(Self-save already used.)</em>' : ''}</p>
      </div>
    `;
    renderTargetGrid(area, targets.filter(p => !(selfSaveUsed && p.id === State.playerId)), (targetId) => {
      State.socket.emit('night_action', { roomCode: State.roomCode, targetId });
      State.nightActionSubmitted = true;
      renderNightPanel(alivePlayers);
    });
    waiting.classList.add('hidden');

  } else if (role === 'detective') {
    const targets = players.filter(p => p.alive && p.id !== State.playerId);
    area.innerHTML = `
      <div class="night-instruction">
        <h3>🔍 Investigate a Player</h3>
        <p>Choose someone to investigate. You'll learn if they're Mafia or not.</p>
      </div>
    `;
    renderTargetGrid(area, targets, (targetId) => {
      State.socket.emit('night_action', { roomCode: State.roomCode, targetId });
      State.nightActionSubmitted = true;
      renderNightPanel(alivePlayers);
    });
    waiting.classList.add('hidden');

  } else {
    // Villager — no night action
    area.innerHTML = `
      <div class="night-instruction">
        <h3>🏘️ Sleep tight…</h3>
        <p>The village sleeps while special roles act in the dark. You'll find out what happened at dawn.</p>
      </div>
    `;
    waiting.classList.add('hidden');
  }

  qs('#night-desc').textContent = getNightDesc(role);
}

function getNightDesc(role) {
  const descs = {
    mafia: 'Coordinate with your team. Choose your victim carefully.',
    doctor: 'Someone needs your protection tonight.',
    detective: 'The truth is out there. Investigate wisely.',
    villager: 'The village sleeps… unaware of the danger.',
  };
  return descs[role] || 'The night is dark and full of secrets.';
}

function renderMafiaTeam(players) {
  const area = qs('#night-action-area');
  const teammates = players.filter(p => p.role === 'mafia' && p.id !== State.playerId);
  if (teammates.length === 0) return;
  const div = document.createElement('div');
  div.className = 'mafia-team-panel';
  div.innerHTML = `<h4>🔫 Your Mafia Team</h4>` +
    teammates.map(p => `<div class="mafia-member">${PLAYER_AVATARS[0]} ${escHtml(p.name)}</div>`).join('');
  area.appendChild(div);
}

function renderTargetGrid(container, targets, onSelect) {
  const grid = document.createElement('div');
  grid.className = 'target-grid';

  targets.forEach((p, i) => {
    const btn = document.createElement('button');
    btn.className = 'target-btn';
    btn.dataset.targetId = p.id;
    btn.innerHTML = `
      <span class="t-avatar">${PLAYER_AVATARS[i % PLAYER_AVATARS.length]}</span>
      <span class="t-name">${escHtml(p.name)}</span>
    `;
    btn.addEventListener('click', () => {
      grid.querySelectorAll('.target-btn').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
      // Disable all after selection
      setTimeout(() => {
        grid.querySelectorAll('.target-btn').forEach(b => b.disabled = true);
        onSelect(p.id);
      }, 400);
    });
    grid.appendChild(btn);
  });

  container.appendChild(grid);
}

// ── Day Reveal ──
function renderNightReveal(data) {
  const area = qs('#reveal-content');
  area.innerHTML = '';

  if (data.killedPlayer) {
    area.innerHTML = `
      <div class="reveal-card death">
        <span class="reveal-icon">💀</span>
        <h3>${escHtml(data.killedPlayer.name)} was found dead!</h3>
        <p>The Mafia struck in the night. The village mourns their loss.</p>
      </div>
    `;
  } else if (data.savedByDoctor) {
    area.innerHTML = `
      <div class="reveal-card saved">
        <span class="reveal-icon">💉</span>
        <h3>${escHtml(data.savedByDoctor.name)} was saved!</h3>
        <p>The Mafia had a target, but the Doctor's protection saved them.</p>
      </div>
    `;
  } else {
    area.innerHTML = `
      <div class="reveal-card quiet">
        <span class="reveal-icon">🌙</span>
        <h3>A peaceful night…</h3>
        <p>Nobody was eliminated. The Mafia couldn't agree on a target.</p>
      </div>
    `;
  }

  showPanel('panel-day-reveal');
}

// ── Day Discussion ──
function renderDiscussPanel() {
  const players = State.gameState?.players || [];
  const alive = players.filter(p => p.alive);
  const mafia = alive.filter(p => p.role === 'mafia').length;
  const village = alive.filter(p => p.role !== 'mafia').length;

  qs('#discuss-status').innerHTML = `
    <p><strong>${alive.length} players</strong> remain alive. Discuss who you think the Mafia is.</p>
    <p style="margin-top:8px; color: var(--text-muted); font-size:0.85rem;">Use the chat to share your suspicions. Voting begins soon.</p>
  `;
}

// ── Day Vote ──
function renderVotePanel(alivePlayers) {
  const area = qs('#vote-action-area');
  area.innerHTML = '';

  const me = State.gameState?.players?.find(p => p.id === State.playerId);
  const canVote = me?.alive;

  if (!canVote) {
    area.innerHTML = `<p style="color:var(--text-muted);font-size:0.9rem;">You are eliminated — watching the vote.</p>`;
    qs('#btn-vote-skip').style.display = 'none';
    return;
  }

  qs('#btn-vote-skip').style.display = '';

  const players = State.gameState?.players || [];
  const targets = players.filter(p => p.alive && p.id !== State.playerId);

  targets.forEach((p, i) => {
    const btn = document.createElement('button');
    btn.className = 'vote-btn';
    btn.dataset.targetId = p.id;
    if (State.myDayVote === p.id) btn.classList.add('voted');
    btn.innerHTML = `
      <span class="v-avatar">${PLAYER_AVATARS[i % PLAYER_AVATARS.length]}</span>
      <span>${escHtml(p.name)}</span>
      <span class="v-count" style="display:none">0</span>
    `;
    btn.addEventListener('click', () => submitDayVote(p.id));
    area.appendChild(btn);
  });
}

function submitDayVote(targetId) {
  if (!State.gameState?.players?.find(p => p.id === State.playerId)?.alive) return;
  State.socket.emit('day_vote', { roomCode: State.roomCode, targetId });
  State.myDayVote = targetId;

  // Visual feedback
  qs('#vote-action-area').querySelectorAll('.vote-btn').forEach(btn => {
    btn.classList.toggle('voted', btn.dataset.targetId === targetId);
  });
  qs('#btn-vote-skip').classList.toggle('btn-primary', targetId === 'skip');
  qs('#btn-vote-skip').classList.toggle('btn-ghost', targetId !== 'skip');
}

// ── Vote Tally ──
function renderVoteTally(tally) {
  const bar = qs('#vote-tally-bar');
  bar.innerHTML = `<h4>🗳️ Current Votes</h4>`;

  if (!tally || !tally.tally) return;

  const total = tally.totalAlive || 1;

  // Sort entries by vote count desc
  const entries = Object.values(tally.tally).sort((a, b) => b.count - a.count);

  if (entries.length === 0) {
    bar.insertAdjacentHTML('beforeend', `<p style="font-size:0.82rem;color:var(--text-muted)">No votes yet.</p>`);
  }

  entries.forEach(entry => {
    const pct = Math.round((entry.count / total) * 100);
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
      <div class="tally-bar-fill"><div class="tally-bar-inner" style="width:${Math.round((tally.skipCount/total)*100)}%;background:var(--text-muted)"></div></div>
      <span class="tally-count">${tally.skipCount}</span>
    `;
    bar.appendChild(row);
  }

  const summary = document.createElement('p');
  summary.style.cssText = 'font-size:0.78rem;color:var(--text-muted);margin-top:6px';
  summary.textContent = `${tally.totalVoted} of ${tally.totalAlive} players have voted.`;
  bar.appendChild(summary);
}

function updateVoteButtons(tally) {
  if (!tally?.tally) return;
  const area = qs('#vote-action-area');
  area.querySelectorAll('.vote-btn').forEach(btn => {
    const tid = btn.dataset.targetId;
    const entry = tally.tally[tid];
    const countEl = btn.querySelector('.v-count');
    if (countEl && entry) {
      countEl.style.display = '';
      countEl.textContent = entry.count;
    } else if (countEl) {
      countEl.style.display = 'none';
    }
  });
}

// ── Vote Result ──
function renderVoteResult(result) {
  const area = qs('#vote-result-content');

  if (result.eliminated) {
    const p = result.eliminated;
    area.innerHTML = `
      <div class="vote-result-card eliminated">
        <span class="reveal-icon">${p.roleEmoji}</span>
        <h3>${escHtml(p.name)} has been eliminated!</h3>
        <p class="vote-result-role">They were the ${escHtml(p.roleLabel)}</p>
        <p style="margin-top:12px;color:var(--text-secondary);font-size:0.88rem">${escHtml(result.message)}</p>
      </div>
    `;
  } else {
    area.innerHTML = `
      <div class="vote-result-card no-elim">
        <span class="reveal-icon">${result.tie ? '⚖️' : '🗳️'}</span>
        <h3>${result.tie ? 'It\'s a tie!' : 'No elimination'}</h3>
        <p style="margin-top:12px;color:var(--text-secondary);font-size:0.88rem">${escHtml(result.message)}</p>
      </div>
    `;
  }

  showPanel('panel-vote-result');
}

// ═══════════════════════════════════════════════
// GAME OVER
// ═══════════════════════════════════════════════
function renderGameOver(data) {
  const { winningTeam, message, players, log } = data;
  const isVillageWin = winningTeam === 'village';
  const myTeam = State.myRoleMeta?.team || 'village';
  const iWon = myTeam === winningTeam;

  const area = qs('#game-over-content');
  area.innerHTML = '';

  // Banner
  const banner = document.createElement('div');
  banner.className = `game-over-banner ${isVillageWin ? 'village-wins' : 'mafia-wins'}`;
  banner.innerHTML = `
    <span class="go-icon">${isVillageWin ? '🏘️' : '🔫'}</span>
    <h2>${isVillageWin ? 'Village Wins!' : 'Mafia Wins!'}</h2>
    <p>${escHtml(message)}</p>
    ${iWon
      ? `<p style="margin-top:10px;font-weight:600;color:${isVillageWin ? 'var(--accent-green)' : 'var(--accent-red)'}">🎉 You won!</p>`
      : `<p style="margin-top:10px;color:var(--text-muted)">Better luck next time.</p>`
    }
  `;
  area.appendChild(banner);

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
      <span class="fp-emoji">${p.roleEmoji || '❓'}</span>
      <span class="fp-name" title="${escHtml(p.name)}">${escHtml(p.name)}</span>
      <span class="fp-role">${escHtml(p.roleLabel)}</span>
      <span class="fp-alive ${p.alive ? 'alive' : 'dead'}">${p.alive ? '● Alive' : '● Dead'}</span>
    `;
    grid.appendChild(card);
  });
  area.appendChild(grid);

  // Actions
  const actions = document.createElement('div');
  actions.className = 'game-over-actions';
  actions.innerHTML = `
    <button class="btn btn-primary" id="btn-play-again">Play Again</button>
    <button class="btn btn-ghost" id="btn-home">Home</button>
  `;
  area.appendChild(actions);

  qs('#btn-play-again').addEventListener('click', () => {
    clearSession();
    showScreen('home');
  });
  qs('#btn-home').addEventListener('click', () => {
    clearSession();
    showScreen('home');
  });

  // Update event log
  renderEventLog(log || []);

  showPanel('panel-game-over');
  stopTimer();
  setTimerProgress(0);
  qs('#timer-value').textContent = '--';
}

// ═══════════════════════════════════════════════
// EVENT LOG
// ═══════════════════════════════════════════════
function renderEventLog(log) {
  const list = qs('#event-log-list');
  list.innerHTML = '';
  log.forEach(entry => {
    const li = document.createElement('li');
    li.className = 'log-item';
    li.innerHTML = `<span class="log-round">R${entry.round}</span>${escHtml(entry.message)}`;
    list.appendChild(li);
  });
}

// ═══════════════════════════════════════════════
// ROLE REVEAL MODAL
// ═══════════════════════════════════════════════
function showRoleModal(state) {
  const { myRole, myRoleMeta, players } = state;
  if (!myRole) return;

  const teammates = players
    .filter(p => p.role === 'mafia' && p.id !== state.myId)
    .map(p => p.name);

  const content = qs('#modal-content');
  content.innerHTML = `
    <span class="modal-role-emoji">${myRoleMeta?.emoji || '❓'}</span>
    <span class="modal-role-name role-${myRole}">${myRoleMeta?.label || myRole}</span>
    <p class="modal-role-desc">${myRoleMeta?.description || ''}</p>
    ${myRole === 'mafia' && teammates.length > 0
      ? `<div class="modal-mafia-team">🔫 Your Mafia team: <strong>${teammates.map(escHtml).join(', ')}</strong></div>`
      : ''
    }
  `;

  qs('#modal-overlay').classList.remove('hidden');
}

// ═══════════════════════════════════════════════
// CHAT
// ═══════════════════════════════════════════════
function addChatMessage(senderName, message, timestamp, isMafiaChat, isDeadChat) {
  const container = qs('#chat-messages');
  const msg = document.createElement('div');
  msg.className = [
    'chat-msg',
    isMafiaChat ? 'mafia-chat' : '',
    isDeadChat  ? 'dead-chat'  : '',
  ].filter(Boolean).join(' ');

  const time = timestamp ? formatTime(new Date(timestamp)) : '';
  msg.innerHTML = `
    <span class="chat-msg-sender">${escHtml(senderName)}</span>
    <span class="chat-msg-time">${time}</span>
    <br/>${escHtml(message)}
  `;
  container.appendChild(msg);
  container.scrollTop = container.scrollHeight;
}

function addSystemChat(message, isMafia = false) {
  const container = qs('#chat-messages');
  const msg = document.createElement('div');
  msg.className = `chat-msg system-msg${isMafia ? ' mafia-chat' : ''}`;
  msg.textContent = message;
  container.appendChild(msg);
  container.scrollTop = container.scrollHeight;
}

// ═══════════════════════════════════════════════
// SCREEN MANAGEMENT
// ═══════════════════════════════════════════════
function showScreen(name) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  qs(`#screen-${name}`)?.classList.add('active');
}

// ═══════════════════════════════════════════════
// CONNECTION BAR
// ═══════════════════════════════════════════════
function showConnectionBar(msg, isReconnected = false) {
  const bar = qs('#connection-bar');
  qs('#connection-msg').textContent = msg;
  bar.classList.remove('hidden', 'reconnected');
  if (isReconnected) bar.classList.add('reconnected');
}

function hideConnectionBar() {
  qs('#connection-bar').classList.add('hidden');
}

// ═══════════════════════════════════════════════
// TOAST NOTIFICATIONS
// ═══════════════════════════════════════════════
function toast(message, type = 'info', duration = 3500) {
  const container = qs('#toast-container');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = message;
  container.appendChild(el);

  setTimeout(() => {
    el.style.animation = 'toastOut 0.3s ease forwards';
    setTimeout(() => el.remove(), 300);
  }, duration);
}

// ═══════════════════════════════════════════════
// SESSION PERSISTENCE (reconnection support)
// ═══════════════════════════════════════════════
const SESSION_KEY = 'mafia_session';

function saveSession() {
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify({
      playerId: State.playerId,
      playerName: State.playerName,
      roomCode: State.roomCode,
    }));
  } catch (_) {}
}

function loadSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (_) {
    return null;
  }
}

function clearSession() {
  State.playerId = null;
  State.playerName = null;
  State.roomCode = null;
  State.isHost = false;
  State.gameState = null;
  State.myRole = null;
  State.myRoleMeta = null;
  try { localStorage.removeItem(SESSION_KEY); } catch (_) {}
}

function attemptReconnect() {
  const session = loadSession();
  if (!session?.playerId || !session?.roomCode) return;

  State.playerId = session.playerId;
  State.playerName = session.playerName;
  State.roomCode = session.roomCode;

  // Socket might not be ready yet; wait for 'connect' event which triggers re-join
  // (handled in s.on('connect') above)
}

// ═══════════════════════════════════════════════
// DECORATIVE: Starfield
// ═══════════════════════════════════════════════
function generateStars() {
  const container = qs('#stars');
  if (!container) return;
  for (let i = 0; i < 120; i++) {
    const star = document.createElement('div');
    star.className = 'star';
    const size = Math.random() * 2.5 + 0.5;
    star.style.cssText = `
      width:${size}px;
      height:${size}px;
      top:${Math.random() * 100}%;
      left:${Math.random() * 100}%;
      --base-opacity:${Math.random() * 0.5 + 0.3};
      --dur:${(Math.random() * 3 + 2).toFixed(1)}s;
      --delay:-${(Math.random() * 4).toFixed(1)}s;
    `;
    container.appendChild(star);
  }
}

// ═══════════════════════════════════════════════
// UTILITIES
// ═══════════════════════════════════════════════
function qs(selector) {
  return document.querySelector(selector);
}

function escHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatTime(date) {
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
