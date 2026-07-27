/* =====================================================================
   PASTEL NUKETOWN — host-authoritative browser multiplayer

   The WebSocket server is deliberately only a room relay. The host browser
   runs the existing simulation and publishes snapshots; guests predict their
   own movement, send input, and interpolate everybody else.
   ===================================================================== */

const NETP = globalThis.NUKETOWN_PROTOCOL;

/* Where the relay lives.

   The page is served from a CDN but the WebSocket relay runs on its own
   host, so the client cannot assume the two share an origin. Netlify (and
   any static host) cannot proxy a WebSocket upgrade, which is why this is
   a separate machine rather than a path on the same one.

   Leave it empty to talk to whatever origin served the page — that is the
   right answer when the relay is also serving the game. A ?server= in the
   URL overrides it either way. */
const NET_SERVER = 'relay.luckeysystems.com';
const NET_SNAPSHOT_INTERVAL = 1 / 20;
const NET_INTERP_SNAPSHOTS = 2;
const NET_MAX_HISTORY_SAMPLES = 32;
const NET_MAX_REPLICA_SAMPLES = 16;
const NET = {
  mode: 'solo',                 // solo | connecting | host | guest
  phase: 'idle',                // idle | connecting | lobby | playing
  socket: null,
  room: '',
  id: '',
  members: [],
  round: 0,
  wanted: null,
  manualClose: false,
  starting: false,
  inputSeq: 0,
  lastFireSeqSent: 0,
  inputSentTimes: new Map(),
  weaponSeq: 0,
  lastInputAck: 0,
  snapshotAcc: 0,
  lastSnapshotTick: -1,
  lastSnapshotTime: -1,
  snapshotInterval: NET_SNAPSHOT_INTERVAL,
  hostClock: 0,
  hostClockAt: 0,
  oneWay: 0,
  renderTime: 0,
  lastInputSentAt: 0,
  eventSeq: 0,
  eventQueue: [],
  lastEventSeq: 0,
  actorManifest: null,
  lastKillerId: null,
  scoreSignature: '',
  connectTimer: 0,
  roomsBusy: false,
  roomsTimer: 0
};

function netIsHost() { return NET.mode === 'host'; }
function netIsGuest() { return NET.mode === 'guest'; }
function netIsMultiplayer() { return netIsHost() || netIsGuest(); }
function netHasTransport() { return NET.mode !== 'solo'; }
function netSocketOpen() { return NET.socket && NET.socket.readyState === WebSocket.OPEN; }

function netColorForIndex(i) {
  const c = BOT_COLORS[(i + 7) % BOT_COLORS.length];
  return { body: c.body, trim: c.trim, name: c.name };
}

function netMemberWithColor(member, i) {
  return {
    id: member.id,
    name: member.name,
    role: member.role,
    colors: netColorForIndex(i)
  };
}

function netLocalPlayerInfo() {
  if (!netIsMultiplayer()) return { id: null, name: 'YOU', colors: PLAYER_COLOR };
  const i = Math.max(0, NET.members.findIndex(m => m.id === NET.id));
  const m = NET.members[i] || { id: NET.id, name: 'PLAYER' };
  return { id: NET.id, name: m.name, colors: netColorForIndex(i) };
}

function netAuthorityRoster() {
  if (!netIsHost()) return [];
  const out = [];
  for (let i = 0; i < NET.members.length; i++) {
    const m = NET.members[i];
    if (m.id !== NET.id) out.push(netMemberWithColor(m, i));
  }
  return out;
}

function netBotCount(humanCount) {
  if (netIsGuest()) return 0;
  if (netIsHost()) return Math.max(0, CFG.combatants - humanCount);
  return CFG.bots;
}

/* Accepts a bare host, a ws(s):// URL, or an http(s):// URL, and hands back a
   relay URL — or null if it is anything we should refuse to dial. */
function netNormalizeServer(value) {
  if (typeof value !== 'string') return null;
  let configured = value.trim();
  if (!configured) return null;

  if (/^https?:\/\//i.test(configured))
    configured = configured.replace(/^http/i, 'ws');
  if (!/^wss?:\/\//i.test(configured))
    configured = (location.protocol === 'https:' ? 'wss://' : 'ws://') + configured;

  try {
    const u = new URL(configured);
    if ((u.protocol !== 'ws:' && u.protocol !== 'wss:') ||
        u.username || u.password || u.hash) return null;
    if (!u.pathname || u.pathname === '/') u.pathname = '/ws';
    return u.toString();
  } catch (e) {}
  return null;
}

function netSameOriginURL() {
  return (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws';
}

function netIsDevOrigin() {
  return NETP.isPrivateHost(location.hostname);
}

function netWsURL() {
  /* An explicit ?server= is the last word, including when it is malformed —
     silently falling back to somewhere else would hide the mistake. */
  const requested = QS.get('server');
  if (requested) return netNormalizeServer(requested);

  if (location.protocol === 'file:') return 'ws://localhost:8080/ws';
  /* Private origins are serving the game from a relay on this LAN; stay on
     that origin instead of sending players in the same room through public. */
  if (netIsDevOrigin()) return netSameOriginURL();

  return netNormalizeServer(NET_SERVER) || netSameOriginURL();
}

/* Same server, plain HTTP. The room list is a poll rather than a socket
   message on purpose: browsing happens before you have joined anything, and
   the relay drops sockets that sit around without entering a room. */
function netRoomsURL() {
  const socketURL = netWsURL();
  if (!socketURL) return null;
  try {
    const u = new URL(socketURL);
    u.protocol = u.protocol === 'wss:' ? 'https:' : 'http:';
    u.pathname = '/rooms';
    u.search = '';
    return u.toString();
  } catch (e) {
    return null;
  }
}

function netRoomsPanelOpen() {
  const title = document.getElementById('title');
  const menu = document.getElementById('menu');
  return !!title && !title.classList.contains('off') &&
         !!menu && !menu.hidden && !menu.classList.contains('pause');
}

function netRenderRooms(rooms, message) {
  const list = document.getElementById('roomList');
  if (!list) return;
  list.innerHTML = '';

  if (!rooms || !rooms.length) {
    const empty = document.createElement('li');
    empty.className = 'rooms-empty';
    empty.textContent = message || 'No open rooms — create one.';
    list.appendChild(empty);
    return;
  }

  for (const room of rooms) {
    const li = document.createElement('li');

    const code = document.createElement('strong');
    code.textContent = room.code;
    li.appendChild(code);

    const host = document.createElement('span');
    host.textContent = room.host;
    li.appendChild(host);

    const seats = document.createElement('b');
    seats.textContent = room.players + '/' + room.max;
    li.appendChild(seats);

    const join = document.createElement('button');
    join.className = 'mini-btn';
    join.type = 'button';
    join.textContent = 'JOIN';
    join.addEventListener('click', () => {
      const input = document.getElementById('roomCode');
      if (input) input.value = room.code;
      netConnect('join', room.code);
    });
    li.appendChild(join);

    list.appendChild(li);
  }
}

function netRefreshRooms(manual) {
  if (NET.roomsBusy || typeof fetch !== 'function') return;
  if (!manual && !netRoomsPanelOpen()) return;

  const url = netRoomsURL();
  if (!url) {
    netRenderRooms(null, 'The multiplayer server address is invalid.');
    return;
  }

  NET.roomsBusy = true;
  const control = typeof AbortController === 'function' ? new AbortController() : null;
  const bail = control ? setTimeout(() => control.abort(), 4000) : 0;

  fetch(url, { cache: 'no-store', signal: control ? control.signal : undefined })
    .then(response => (response.ok ? response.json() : Promise.reject(response.status)))
    .then(body => {
      const rooms = NETP.cleanRoomSummaries(body && body.rooms, NETP.MAX_ROOM_LIST);
      /* A refresh that lands after the player has already left the menu must
         not repaint a list they can no longer act on. */
      if (netRoomsPanelOpen()) netRenderRooms(rooms);
    })
    .catch(() => {
      if (netRoomsPanelOpen())
        netRenderRooms(null, 'No room server reachable.');
    })
    .then(() => {
      if (bail) clearTimeout(bail);
      NET.roomsBusy = false;
    });
}

function netSend(msg, lossy) {
  if (!netSocketOpen()) return false;
  if (NET.socket.bufferedAmount > 1024 * 1024) {
    netStatus('Connection is too far behind; disconnecting.', 'error');
    try { NET.socket.close(1013, 'client backpressure'); } catch (e) {}
    return false;
  }
  if (lossy && NET.socket.bufferedAmount > 128 * 1024) return false;
  try {
    const encoded = JSON.stringify(msg);
    if (!encoded || (NETP && encoded.length > NETP.MAX_MESSAGE_BYTES)) return false;
    NET.socket.send(encoded);
    return true;
  } catch (e) {
    return false;
  }
}

function netCleanMembers(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > NETP.MAX_PLAYERS) return null;
  const ids = new Set();
  const members = [];
  let hosts = 0;
  for (const raw of value) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) ||
        typeof raw.id !== 'string' || !raw.id || raw.id.length > 80 ||
        typeof raw.name !== 'string' || (raw.role !== 'host' && raw.role !== 'guest') ||
        ids.has(raw.id)) return null;
    const name = NETP.cleanPlayerName(raw.name);
    if (!name) return null;
    ids.add(raw.id);
    if (raw.role === 'host') hosts++;
    members.push({ id: raw.id, name: name, role: raw.role });
  }
  return hosts === 1 ? members : null;
}

function netStatus(text, kind) {
  const el = document.getElementById('netStatus');
  if (!el) return;
  el.textContent = text || '';
  el.dataset.kind = kind || '';
}

function netShowLobby() {
  const menu = document.getElementById('menu');
  const lobby = document.getElementById('lobby');
  if (menu) menu.hidden = true;
  if (lobby) lobby.hidden = false;
  const code = document.getElementById('lobbyCode');
  if (code) code.textContent = NET.room || '······';
  const start = document.getElementById('netStart');
  const play = document.getElementById('play');
  if (play) play.disabled = false;
  if (start) {
    start.hidden = !netIsHost();
    start.disabled = NET.phase !== 'lobby';
  }
  netRenderMembers();
}

function netShowMainMenu(message) {
  const menu = document.getElementById('menu');
  const lobby = document.getElementById('lobby');
  if (menu) { menu.hidden = false; menu.classList.remove('pause'); }
  if (lobby) lobby.hidden = true;
  const play = document.getElementById('play');
  if (play) { play.textContent = 'SOLO'; play.disabled = false; }
  const host = document.getElementById('hostGame');
  const join = document.getElementById('joinGame');
  if (host) host.disabled = false;
  if (join) join.disabled = false;
  const note = document.getElementById('menuNote');
  if (note) note.textContent = message ||
    'Join an open room below, create your own, or enter a six-character code.';
  netRefreshRooms(true);
}

function netSetPauseMenu(paused) {
  const menu = document.getElementById('menu');
  const lobby = document.getElementById('lobby');
  if (menu) {
    menu.hidden = false;
    menu.classList.toggle('pause', !!paused);
  }
  if (lobby) lobby.hidden = true;
  const note = document.getElementById('menuNote');
  if (note && paused)
    note.textContent = netIsMultiplayer() ? 'The room keeps running while this menu is open.' : 'Game paused.';
}

function netRenderMembers() {
  const list = document.getElementById('roster');
  if (!list) return;
  list.innerHTML = '';
  for (const member of NET.members) {
    const li = document.createElement('li');
    const sw = document.createElement('i');
    const i = NET.members.indexOf(member);
    sw.style.background = '#' + netColorForIndex(i).body.toString(16).padStart(6, '0');
    li.appendChild(sw);
    const name = document.createElement('span');
    name.textContent = member.name + (member.id === NET.id ? ' (YOU)' : '');
    li.appendChild(name);
    const role = document.createElement('b');
    role.textContent = member.role === 'host' ? 'HOST' : 'READY';
    li.appendChild(role);
    list.appendChild(li);
  }
  const count = document.getElementById('rosterCount');
  if (count) count.textContent = NET.members.length + ' / ' + (NETP ? NETP.MAX_PLAYERS : 4);
}

function netResetTransport() {
  if (NET.connectTimer) clearTimeout(NET.connectTimer);
  NET.connectTimer = 0;
  if (NET.socket) {
    NET.manualClose = true;
    try { NET.socket.close(1000, 'leaving'); } catch (e) {}
  }
  NET.socket = null;
  NET.mode = 'solo';
  NET.phase = 'idle';
  NET.room = '';
  NET.id = '';
  NET.members = [];
  NET.round = 0;
  NET.wanted = null;
  NET.starting = false;
  NET.inputSeq = 0;
  NET.lastFireSeqSent = 0;
  NET.inputSentTimes.clear();
  NET.weaponSeq = 0;
  NET.lastInputAck = 0;
  NET.snapshotAcc = 0;
  NET.lastSnapshotTick = -1;
  NET.lastSnapshotTime = -1;
  NET.snapshotInterval = NET_SNAPSHOT_INTERVAL;
  NET.hostClock = 0;
  NET.hostClockAt = 0;
  NET.oneWay = 0;
  NET.renderTime = 0;
  NET.lastInputSentAt = 0;
  NET.eventSeq = 0;
  NET.eventQueue = [];
  NET.lastEventSeq = 0;
  NET.actorManifest = null;
  NET.lastKillerId = null;
  NET.scoreSignature = '';
  NET.manualClose = false;
}

function netConnect(kind, requestedRoom) {
  if (!NETP || typeof WebSocket !== 'function') {
    netStatus('Multiplayer is not supported in this browser.', 'error');
    return;
  }
  const nameEl = document.getElementById('playerName');
  const name = NETP.cleanPlayerName(nameEl && nameEl.value);
  if (nameEl) nameEl.value = name;
  try { localStorage.setItem('pastel-nuketown-name', name); } catch (e) {}
  const room = NETP.normalizeRoomCode(requestedRoom || '');
  if (kind === 'join' && room.length !== 6) {
    netStatus('Enter the six-character room code.', 'error');
    return;
  }

  const listedEl = document.getElementById('roomPublic');
  const listed = !listedEl || !!listedEl.checked;

  netResetTransport();
  NET.mode = 'connecting';
  NET.phase = 'connecting';
  NET.wanted = { kind, name, room, listed };
  netStatus(kind === 'create' ? 'Creating room…' : 'Finding room ' + room + '…');
  const hostBtn = document.getElementById('hostGame');
  const joinBtn = document.getElementById('joinGame');
  const playBtn = document.getElementById('play');
  if (hostBtn) hostBtn.disabled = true;
  if (joinBtn) joinBtn.disabled = true;
  if (playBtn) playBtn.disabled = true;

  const socketURL = netWsURL();
  if (!socketURL) {
    netResetTransport();
    netShowMainMenu();
    netStatus('The multiplayer server address is invalid.', 'error');
    return;
  }

  let ws;
  try { ws = new WebSocket(socketURL); }
  catch (e) {
    netResetTransport();
    netShowMainMenu();
    netStatus('Could not open the multiplayer server.', 'error');
    return;
  }
  NET.socket = ws;
  ws.addEventListener('open', () => {
    if (NET.socket !== ws || !NET.wanted) return;
    const w = NET.wanted;
    netSend({ t: w.kind, v: NETP.VERSION, room: w.room, name: w.name, listed: w.listed });
  });
  ws.addEventListener('message', e => netHandleWire(e.data));
  ws.addEventListener('error', () => {
    if (NET.socket === ws && NET.phase === 'connecting') {
      netStatus('Could not reach the multiplayer server.', 'error');
      try { ws.close(); } catch (e) {}
    }
  });
  ws.addEventListener('close', () => {
    if (NET.socket !== ws) return;
    const wasPlaying = NET.phase === 'playing';
    const manual = NET.manualClose;
    NET.socket = null;
    if (!manual) {
      if (wasPlaying) {
        netEndSession('Connection lost — return to the menu to reconnect.');
      } else {
        NET.mode = 'solo'; NET.phase = 'idle';
        netShowMainMenu('Connection closed. Is the game server running?');
        netStatus('Connection closed.', 'error');
      }
    }
    if (hostBtn) hostBtn.disabled = false;
    if (joinBtn) joinBtn.disabled = false;
    if (playBtn) playBtn.disabled = false;
  });
  NET.connectTimer = setTimeout(() => {
    if (NET.phase !== 'connecting') return;
    netStatus('The multiplayer server did not answer.', 'error');
    try { ws.close(); } catch (e) {}
  }, 9000);
}

function netHandleWire(raw) {
  let msg;
  try { msg = JSON.parse(raw); } catch (e) { return; }
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return;

  if (msg.t === 'room') {
    const members = netCleanMembers(msg.members);
    const room = NETP.normalizeRoomCode(msg.room);
    if (NET.phase !== 'connecting' || typeof msg.id !== 'string' || !msg.id ||
        msg.id.length > 80 || room.length !== 6 ||
        (msg.role !== 'host' && msg.role !== 'guest') || !members ||
        !members.some(member => member.id === msg.id && member.role === msg.role)) {
      if (NET.socket) try { NET.socket.close(1008, 'invalid room handshake'); } catch (e) {}
      return;
    }
    if (NET.connectTimer) clearTimeout(NET.connectTimer);
    NET.connectTimer = 0;
    NET.id = msg.id;
    NET.room = room;
    NET.mode = msg.role === 'host' ? 'host' : 'guest';
    NET.phase = 'lobby';
    NET.members = members;
    /* Adopt the room's round at the handshake. Joining a room that has
       already played a round leaves NET.round behind otherwise, and every
       subsequent `start` looks like it skipped ahead and gets ignored. */
    NET.round = Number.isSafeInteger(msg.round) && msg.round >= 0 ? msg.round : 0;
    netShowLobby();
    netStatus(netIsHost() ? 'Room ready — share the code, then start.' : 'Connected — waiting for the host.');
    return;
  }
  if (msg.t === 'members') {
    const members = netCleanMembers(msg.members);
    if (!netIsMultiplayer() || !members || !members.some(member => member.id === NET.id)) return;
    NET.members = members;
    netRenderMembers();
    if (netIsHost() && NET.phase === 'playing') netPruneDepartedPlayers();
    return;
  }
  if (msg.t === 'start') {
    const members = netCleanMembers(msg.members);
    /* Rounds only ever move forward. Requiring exactly +1 breaks any client
       whose baseline came from the handshake rather than from round 1. */
    if (!netIsMultiplayer() || !Number.isSafeInteger(msg.round) ||
        msg.round <= NET.round || !members ||
        !members.some(member => member.id === NET.id)) return;
    NET.round = msg.round;
    NET.members = members;
    NET.starting = false;
    netBeginMatch();
    return;
  }
  if (msg.t === 'lobby' && netIsGuest() && NET.phase === 'playing' &&
      msg.round === NET.round) {
    netShowRemoteMatchOver(typeof msg.winner === 'string' ? msg.winner : null);
    return;
  }
  if (msg.t === 'input' && netIsHost() && NET.phase === 'playing' &&
      msg.round === NET.round && typeof msg.from === 'string') {
    const a = G.actors.find(x => x.controller === 'remote' && x.netId === msg.from);
    if (!a) return;
    const checked = NETP.sanitizeInput(msg, a.lastInputSeq, a.lastWeaponSeq);
    if (!checked.ok) return;
    a.netInput = checked.value;
    a.lastInputSeq = checked.value.seq;
    a.lastWeaponSeq = checked.value.weaponSeq;
    a.netInputAt = G.time;
    return;
  }
  if (msg.t === 'snapshot' && netIsGuest() && NET.phase === 'playing' &&
      msg.round === NET.round) {
    netApplySnapshot(msg);
    return;
  }
  if (msg.t === 'event' && netIsGuest() && NET.phase === 'playing' &&
      msg.round === NET.round && Array.isArray(msg.events) && msg.events.length <= 256) {
    for (const event of msg.events) netApplyEvent(event);
    return;
  }
  if (msg.t === 'room-closed') {
    netEndSession('The host closed the room.');
    return;
  }
  if (msg.t === 'error') {
    const errorText = typeof msg.message === 'string' && msg.message
      ? msg.message.slice(0, 200)
      : 'Multiplayer error.';
    NET.starting = false;
    if (NET.phase === 'connecting') {
      netResetTransport();
      netShowMainMenu();
      netStatus(errorText, 'error');
    } else {
      const start = document.getElementById('netStart');
      const again = document.getElementById('again');
      if (start) start.disabled = NET.phase !== 'lobby';
      if (again && G.over && netIsHost()) {
        again.disabled = false;
        again.textContent = 'START REMATCH';
      }
      netStatus(errorText, 'error');
    }
  }
}

function netHostStart() {
  if (!netIsHost() || NET.starting ||
      (NET.phase !== 'lobby' && NET.phase !== 'playing')) return;
  NET.starting = true;
  const start = document.getElementById('netStart');
  const again = document.getElementById('again');
  if (start) start.disabled = true;
  if (again && G.over) {
    again.disabled = true;
    again.textContent = 'STARTING…';
  }
  netStatus('Starting the match…');
  if (!netSend({ t: 'start', v: NETP.VERSION })) {
    NET.starting = false;
    if (start) start.disabled = false;
    if (again && G.over) {
      again.disabled = false;
      again.textContent = 'START REMATCH';
    }
    netStatus('Could not start the match.', 'error');
  }
}

function netBeginMatch() {
  NET.phase = 'playing';
  NET.starting = false;
  NET.inputSeq = 0;
  NET.lastFireSeqSent = 0;
  NET.inputSentTimes.clear();
  NET.weaponSeq = 0;
  NET.lastInputAck = 0;
  NET.snapshotAcc = 0;
  NET.lastSnapshotTick = -1;
  NET.lastSnapshotTime = -1;
  NET.snapshotInterval = NET_SNAPSHOT_INTERVAL;
  NET.hostClock = 0;
  NET.hostClockAt = 0;
  NET.oneWay = 0;
  NET.renderTime = 0;
  NET.lastInputSentAt = 0;
  NET.eventSeq = 0;
  NET.eventQueue = [];
  NET.lastEventSeq = 0;
  NET.actorManifest = null;
  NET.lastKillerId = null;
  NET.scoreSignature = '';
  IN.firing = false;
  IN._heldSemi = false;
  IN.fireSeq = 0;
  IN.fireRenderTime = 0;
  IN.reloadSeq = 0;
  startMatch();
  if (netIsHost()) {
    /* Establish the actor manifest before the first combat event can race
       ahead of it on a guest connection. */
    NET.snapshotAcc = 0.05;
    netAfterSimulation(0);
  }
  if (netIsMultiplayer()) {
    /* A message from the host is not a browser user gesture, so Pointer Lock
       cannot reliably start here. Leave a one-click deploy card. The host
       keeps simulating with neutral input while its card is open. */
    setPaused(true);
    document.getElementById('play').textContent = 'ENTER MATCH';
    const note = document.getElementById('menuNote');
    if (note) note.textContent = 'The match is live. Click to deploy.';
  }
  netStatus('');
  showHint(netIsHost() ? 'YOU ARE THE HOST' : 'CONNECTED TO ' + NET.room);
}

function netLeaveLobby() {
  netResetTransport();
  netShowMainMenu();
  netStatus('');
}

function netEndSession(message) {
  if (G.started) {
    G.paused = true;
    exitPointerLock();
    document.getElementById('hud').classList.add('hide');
    document.getElementById('dead').classList.add('off');
    document.getElementById('over').classList.add('off');
    restoreBoard();
    document.getElementById('title').classList.remove('off');
    G.started = false; G.over = false;
  }
  netResetTransport();
  netShowMainMenu(message);
}

function netPruneDepartedPlayers() {
  const live = new Set(NET.members.map(m => m.id));
  for (const a of G.actors.slice()) {
    if (a.controller === 'remote' && !live.has(a.netId)) detachActor(a);
  }
  refreshBoard();
}

function netActorId(a) {
  return a && (a.netId || ('actor-' + a.id));
}

function netOnLocalWeaponChanged() {
  if (netIsGuest()) NET.weaponSeq++;
}

function netRound(v) { return Math.round(v * 1000) / 1000; }
function netPackActor(a) {
  const remote = a.controller === 'remote';
  return {
    id: a.id,
    netId: netActorId(a),
    name: a.name,
    human: !!a.isHuman,
    colors: { body: a.colors.body, trim: a.colors.trim, name: a.colors.name || '' },
    pos: [netRound(a.pos.x), netRound(a.pos.y), netRound(a.pos.z)],
    vel: [netRound(a.vel.x), netRound(a.vel.y), netRound(a.vel.z)],
    yaw: netRound(a.yaw),
    pitch: netRound(a.pitch),
    aimYaw: netRound(a.aimYaw),
    aimPitch: netRound(a.aimPitch),
    bodyYaw: netRound(a.bodyYaw),
    onGround: !!a.onGround,
    aiming: !!a.aiming,
    health: netRound(a.health),
    maxHealth: a.maxHealth,
    alive: !!a.alive,
    deathT: netRound(a.deathT),
    respawnT: netRound(a.respawnT),
    shield: netRound(a.shield),
    weapon: a.weapon,
    ammo: a.ammo,
    reserve: a.reserve,
    reloadT: netRound(a.reloadT),
    ack: remote ? a.inputAck : 0,
    weaponSeq: remote ? a.weaponAck : 0,
    kills: a.kills,
    deaths: a.deaths,
    streak: a.streak,
    bestStreak: a.bestStreak,
    lastHitBy: a.lastHitBy
  };
}

function netFlushEvents() {
  if (!NET.eventQueue.length) return;
  const events = NET.eventQueue.splice(0, NET.eventQueue.length);
  netSend({
    t: 'event',
    v: NETP.VERSION,
    round: NET.round,
    events: events
  });
}

function netRecordActorHistory() {
  const cutoff = G.time - NETP.MAX_REWIND_SECONDS;
  for (const a of G.actors) {
    if (!a.netHistory) a.netHistory = [];
    const history = a.netHistory;
    const sample = {
      time: G.time,
      pos: [a.pos.x, a.pos.y, a.pos.z],
      alive: !!a.alive
    };
    if (history.length && history[history.length - 1].time === G.time)
      history[history.length - 1] = sample;
    else
      history.push(sample);

    /* Keep the sample just before the cutoff so interpolation at the edge is
       still defined, then impose a hard cap in case simulation cadence changes. */
    while (history.length > 2 && history[1].time < cutoff) history.shift();
    if (history.length > NET_MAX_HISTORY_SAMPLES)
      history.splice(0, history.length - NET_MAX_HISTORY_SAMPLES);
  }
}

function netHistoryStateAt(history, time) {
  if (!history || !history.length || time < history[0].time) return null;
  const selected = NETP.selectTimedSamples(history, time, 0);
  if (!selected) return null;
  const from = history[selected.from], to = history[selected.to];
  const alpha = selected.alpha;
  return {
    pos: [
      lerp(from.pos[0], to.pos[0], alpha),
      lerp(from.pos[1], to.pos[1], alpha),
      lerp(from.pos[2], to.pos[2], alpha)
    ],
    alive: alpha >= 1 ? to.alive : from.alive
  };
}

function netBeginLagCompensation(shooter, renderTime) {
  if (!netIsHost() || shooter.controller !== 'remote' ||
      !shooter.netHistory || !shooter.netHistory.length) return null;
  /* The client chooses this timestamp, so malformed, future, and older-than-
     history requests get no rewind at all; a guest never gets an arbitrary
     trip through match history. */
  const rewindTime = NETP.clampRewindTime(
    renderTime, G.time, shooter.netHistory[0].time, NETP.MAX_REWIND_SECONDS);
  if (rewindTime === null) return null;

  const saved = [];
  const restore = () => {
    for (const state of saved) {
      state.actor.pos.x = state.x;
      state.actor.pos.y = state.y;
      state.actor.pos.z = state.z;
      state.actor.alive = state.alive;
    }
    saved.length = 0;
  };

  try {
    for (const actor of G.actors) {
      if (actor === shooter) continue;
      const past = netHistoryStateAt(actor.netHistory, rewindTime);
      if (!past) continue;
      saved.push({
        actor: actor,
        x: actor.pos.x, y: actor.pos.y, z: actor.pos.z,
        alive: actor.alive
      });
      actor.pos.x = past.pos[0];
      actor.pos.y = past.pos[1];
      actor.pos.z = past.pos[2];
      actor.alive = past.alive;
    }
  } catch (error) {
    restore();
    throw error;
  }

  return saved.length ? restore : null;
}

function netAfterSimulation(dt, force) {
  if (netIsHost() && NET.phase === 'playing') netRecordActorHistory();
  if (!netIsHost() || NET.phase !== 'playing' || !netSocketOpen()) return;
  NET.snapshotAcc += dt;
  if (!force && NET.snapshotAcc < NET_SNAPSHOT_INTERVAL) return;
  NET.snapshotAcc = force ? 0 : NET.snapshotAcc % NET_SNAPSHOT_INTERVAL;
  netSend({
    t: 'snapshot',
    v: NETP.VERSION,
    round: NET.round,
    tick: G.tick,
    time: netRound(G.time),
    actors: G.actors.map(netPackActor),
    over: !!G.over,
    winner: G.winner ? netActorId(G.winner) : null
  }, !force);
  netFlushEvents();
}

function netGuestRenderTime(nowSeconds) {
  if (!NET.hostClockAt) return 0;
  const hostClock = NET.hostClock + Math.max(0, nowSeconds - NET.hostClockAt);
  /* Two snapshots leave a bracketing pair at the normal 20 Hz send rate,
     while adapting automatically if that cadence is changed later. */
  return Math.max(0, hostClock - NET.snapshotInterval * NET_INTERP_SNAPSHOTS);
}

function netObserveInputAck(ack) {
  if (!Number.isSafeInteger(ack) || ack <= NET.lastInputAck) return;
  const sentAt = NET.inputSentTimes.get(ack);
  if (Number.isFinite(sentAt)) {
    const roundTrip = performance.now() / 1000 - sentAt;
    if (roundTrip >= 0 && roundTrip <= 2) {
      const sample = roundTrip * 0.5;
      NET.oneWay = NET.oneWay > 0 ? lerp(NET.oneWay, sample, 0.2) : sample;
    }
  }
  NET.lastInputAck = ack;
  for (const seq of NET.inputSentTimes.keys()) {
    if (seq <= ack) NET.inputSentTimes.delete(seq);
  }
}

function netDisplayedRenderTime() {
  return NET.renderTime;
}

function netFrame(now) {
  if (!netIsGuest() || NET.phase !== 'playing' || !G.player || !netSocketOpen()) return;
  const nextRenderTime = netGuestRenderTime(now / 1000);
  const displayedRenderTime = NET.renderTime || nextRenderTime;
  NET.renderTime = nextRenderTime;
  if (now - NET.lastInputSentAt < 33) return;
  NET.lastInputSentAt = now;
  const active = G.started && !G.paused && !G.over && G.player.alive;
  const p = G.player;
  const edgePending = IN.fireSeq > NET.lastFireSeqSent;
  const inputRenderTime = edgePending && Number.isFinite(IN.fireRenderTime)
    ? IN.fireRenderTime
    : displayedRenderTime;
  const seq = ++NET.inputSeq;
  const message = {
    t: 'input',
    v: NETP.VERSION,
    round: NET.round,
    seq: seq,
    fwd: active ? (KEY.KeyW ? 1 : 0) - (KEY.KeyS ? 1 : 0) : 0,
    strafe: active ? (KEY.KeyD ? 1 : 0) - (KEY.KeyA ? 1 : 0) : 0,
    jump: active && !!KEY.Space,
    sprint: active && (!!KEY.ShiftLeft || !!KEY.ShiftRight),
    fire: active && !!IN.firing,
    fireSeq: IN.fireSeq,
    weaponSeq: NET.weaponSeq,
    reloadSeq: IN.reloadSeq,
    yaw: p.yaw,
    pitch: p.pitch,
    renderTime: inputRenderTime,
    weapon: p.weapon
  };
  if (netSend(message)) {
    NET.lastFireSeqSent = IN.fireSeq;
    NET.inputSentTimes.set(seq, now / 1000);
    if (NET.inputSentTimes.size > 64)
      NET.inputSentTimes.delete(NET.inputSentTimes.keys().next().value);
  }
}

function netFiniteIn(value, min, max) {
  return Number.isFinite(value) && value >= min && value <= max;
}

function netSafeCount(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000;
}

function netValidActorState(s) {
  const b = MAP.bounds;
  return !!(s && typeof s === 'object' && !Array.isArray(s) &&
    Number.isSafeInteger(s.id) && s.id > 0 && s.id <= 100_000 &&
    typeof s.netId === 'string' && s.netId.length > 0 && s.netId.length <= 80 &&
    typeof s.name === 'string' && !!NETP.cleanPlayerName(s.name) &&
    typeof s.human === 'boolean' &&
    s.colors && typeof s.colors === 'object' && !Array.isArray(s.colors) &&
    Number.isSafeInteger(s.colors.body) && s.colors.body >= 0 && s.colors.body <= 0xffffff &&
    Number.isSafeInteger(s.colors.trim) && s.colors.trim >= 0 && s.colors.trim <= 0xffffff &&
    typeof s.colors.name === 'string' && s.colors.name.length <= 40 &&
    Array.isArray(s.pos) && s.pos.length === 3 &&
    netFiniteIn(s.pos[0], b.minX - 3, b.maxX + 3) &&
    netFiniteIn(s.pos[1], -2, 20) &&
    netFiniteIn(s.pos[2], b.minZ - 3, b.maxZ + 3) &&
    Array.isArray(s.vel) && s.vel.length === 3 &&
    s.vel.every(value => netFiniteIn(value, -80, 80)) &&
    netFiniteIn(s.yaw, -100, 100) && netFiniteIn(s.pitch, -2, 2) &&
    netFiniteIn(s.aimYaw, -100, 100) && netFiniteIn(s.aimPitch, -2, 2) &&
    netFiniteIn(s.bodyYaw, -100, 100) &&
    typeof s.onGround === 'boolean' && typeof s.aiming === 'boolean' &&
    netFiniteIn(s.health, 0, 500) && netFiniteIn(s.maxHealth, 1, 500) &&
    typeof s.alive === 'boolean' &&
    netFiniteIn(s.deathT, 0, 60) && netFiniteIn(s.respawnT, 0, 60) &&
    netFiniteIn(s.shield, 0, 60) && !!WBY[s.weapon] &&
    netSafeCount(s.ammo) && netSafeCount(s.reserve) &&
    netFiniteIn(s.reloadT, 0, 60) &&
    Number.isSafeInteger(s.ack) && s.ack >= 0 &&
    Number.isSafeInteger(s.weaponSeq) && s.weaponSeq >= 0 &&
    netSafeCount(s.kills) && netSafeCount(s.deaths) &&
    netSafeCount(s.streak) && netSafeCount(s.bestStreak));
}

function netCreateReplica(s) {
  const colors = { body: s.colors.body, trim: s.colors.trim, name: s.colors.name };
  const a = makeActor({
    id: Number.isInteger(s.id) ? s.id : undefined,
    netId: s.netId,
    name: NETP.cleanPlayerName(s.name),
    controller: 'replica',
    isHuman: !!s.human,
    colors: colors,
    weapon: s.weapon
  });
  a.pos.x = s.pos[0]; a.pos.y = s.pos[1]; a.pos.z = s.pos[2];
  a.vel.x = s.vel[0]; a.vel.y = s.vel[1]; a.vel.z = s.vel[2];
  a.yaw = s.yaw; a.aimYaw = s.aimYaw; a.aimPitch = s.aimPitch; a.bodyYaw = s.bodyYaw;
  a.netSamples = [];
  attachCharacter(a);
  G.actors.push(a);
  return a;
}

function netPushReplicaSample(a, s, sampleTime) {
  if (!Number.isFinite(sampleTime)) return;
  if (!a.netSamples) a.netSamples = [];
  const samples = a.netSamples;
  const previous = samples[samples.length - 1];
  const sample = {
    time: sampleTime,
    pos: s.pos.slice(),
    vel: s.vel.slice(),
    yaw: s.yaw,
    pitch: s.pitch,
    aimYaw: s.aimYaw,
    aimPitch: s.aimPitch,
    bodyYaw: s.bodyYaw
  };

  if (previous) {
    const jump = Math.hypot(
      sample.pos[0] - previous.pos[0],
      sample.pos[1] - previous.pos[1],
      sample.pos[2] - previous.pos[2]);
    /* A teleport is not motion to smooth. Throw away the old timeline so it
       cannot drag a respawn or rejoin across the map for several frames. */
    if (jump > 6) {
      samples.length = 0;
      a.pos.x = sample.pos[0]; a.pos.y = sample.pos[1]; a.pos.z = sample.pos[2];
    }
  }

  if (samples.length && samples[samples.length - 1].time === sampleTime)
    samples[samples.length - 1] = sample;
  else
    samples.push(sample);
  if (samples.length > NET_MAX_REPLICA_SAMPLES)
    samples.splice(0, samples.length - NET_MAX_REPLICA_SAMPLES);
}

function netApplyActorState(a, s, local, sampleTime) {
  const wasAlive = a.alive;
  const oldHp = a.health;
  const oldWeapon = a.weapon;
  a.name = NETP.cleanPlayerName(s.name);
  a.maxHealth = clamp(s.maxHealth, 1, 500);
  a.health = clamp(s.health, 0, a.maxHealth);
  a.alive = !!s.alive;
  a.respawnT = Math.max(0, s.respawnT || 0);
  a.shield = Math.max(0, s.shield || 0);
  a.onGround = !!s.onGround;
  a.aiming = !!s.aiming;
  const applyWeaponState = !local ||
    NETP.isWeaponStateAcknowledged(NET.weaponSeq, s.weaponSeq);
  if (applyWeaponState) {
    a.weapon = WBY[s.weapon] ? s.weapon : a.weapon;
    a.ammo = Math.max(0, Math.floor(s.ammo || 0));
    a.reserve = Math.max(0, Math.floor(s.reserve || 0));
    a.reloadT = Math.max(0, s.reloadT || 0);
  }
  a.kills = Math.max(0, Math.floor(s.kills || 0));
  a.deaths = Math.max(0, Math.floor(s.deaths || 0));
  a.streak = Math.max(0, Math.floor(s.streak || 0));
  a.bestStreak = Math.max(0, Math.floor(s.bestStreak || 0));

  if (local) {
    netObserveInputAck(s.ack);
    if (Number.isInteger(s.id)) a.id = s.id;
    const dx = s.pos[0] - a.pos.x, dy = s.pos[1] - a.pos.y, dz = s.pos[2] - a.pos.z;
    const err = Math.hypot(dx, dy, dz);
    const correction = err > 3 ? 1 : 0.16;
    a.pos.x += dx * correction; a.pos.y += dy * correction; a.pos.z += dz * correction;
    a.vel.x = lerp(a.vel.x, s.vel[0], 0.3);
    a.vel.y = lerp(a.vel.y, s.vel[1], 0.3);
    a.vel.z = lerp(a.vel.z, s.vel[2], 0.3);
    if (oldWeapon !== a.weapon) vmSetWeapon(a.weapon);
    if (wasAlive && !a.alive) {
      const killer = G.actors.find(x => x.netId === NET.lastKillerId);
      showDeadScreen(killer || null);
    } else if (!wasAlive && a.alive) {
      hideDeadScreen();
      SFX.spawn();
      setDamageDirsCleared();
    }
  } else {
    netPushReplicaSample(a, s, sampleTime);
    if (wasAlive && !a.alive) {
      a.deathT = 0; a.deathDir = rng() < 0.5 ? -1 : 1;
      if (a.plate) a.plate.sprite.visible = false;
    } else if (!wasAlive && a.alive) {
      a.deathT = 0; a.spawnT = 0.45;
      if (a.plate) a.plate.sprite.visible = true;
      if (a.char) { a.char.root.visible = true; a.char.root.scale.setScalar(0.001); }
    }
  }
  if (a.plate && (oldHp !== a.health || wasAlive !== a.alive))
    drawPlate(a.plate, a.name, a.health, a.maxHealth, a.colors.body);
}

function netApplySnapshot(msg) {
  if (!Number.isSafeInteger(msg.tick) || msg.tick < 0 || msg.tick <= NET.lastSnapshotTick ||
      !netFiniteIn(msg.time, 0, 100_000_000) || typeof msg.over !== 'boolean' ||
      !Array.isArray(msg.actors) || msg.actors.length < 1 || msg.actors.length > 16) return;

  const seen = new Set();
  for (const state of msg.actors) {
    if (!netValidActorState(state) || seen.has(state.netId)) return;
    seen.add(state.netId);
  }
  if (!seen.has(NET.id)) return;
  if (NET.actorManifest) {
    for (const id of seen) if (!NET.actorManifest.has(id)) return;
  } else {
    NET.actorManifest = new Set(seen);
  }
  if (msg.over &&
      (typeof msg.winner !== 'string' || !NET.actorManifest.has(msg.winner))) return;

  NET.lastSnapshotTick = msg.tick;
  if (NET.lastSnapshotTime >= 0) {
    const interval = msg.time - NET.lastSnapshotTime;
    if (interval >= NET_SNAPSHOT_INTERVAL * 0.5 && interval <= NET_SNAPSHOT_INTERVAL * 4)
      NET.snapshotInterval = lerp(NET.snapshotInterval, interval, 0.2);
  }
  NET.lastSnapshotTime = msg.time;
  G.time = lerp(G.time, msg.time, 0.16);

  for (const s of msg.actors) {
    let a;
    if (s.netId === NET.id) {
      a = G.player;
      a.netId = NET.id;
    } else {
      a = G.actors.find(x => x.netId === s.netId);
      if (!a) a = netCreateReplica(s);
    }
    netApplyActorState(a, s, a === G.player, msg.time);
  }
  NET.hostClock = msg.time + NET.oneWay;
  NET.hostClockAt = performance.now() / 1000;
  for (const a of G.actors.slice()) {
    if (!a.isPlayer && !seen.has(a.netId)) detachActor(a);
  }

  const sig = G.actors.map(a => a.netId + ':' + a.kills + ':' + a.deaths + ':' + a.bestStreak).join('|');
  if (sig !== NET.scoreSignature) {
    NET.scoreSignature = sig;
    refreshBoard();
  }
  if (msg.over) netShowRemoteMatchOver(msg.winner);
}

function netStepReplica(a, dt) {
  const samples = a.netSamples;
  const selected = NETP.selectTimedSamples(
    samples, NET.renderTime, NET.snapshotInterval * NET_INTERP_SNAPSHOTS);
  if (!selected) return;
  const from = samples[selected.from], to = samples[selected.to];
  const alpha = selected.alpha, extra = selected.extrapolation;
  const targetPos = [
    lerp(from.pos[0], to.pos[0], alpha) + to.vel[0] * extra,
    lerp(from.pos[1], to.pos[1], alpha) + to.vel[1] * extra,
    lerp(from.pos[2], to.pos[2], alpha) + to.vel[2] * extra
  ];
  a.pos.x = targetPos[0]; a.pos.y = targetPos[1]; a.pos.z = targetPos[2];
  a.vel.x = lerp(from.vel[0], to.vel[0], alpha);
  a.vel.y = lerp(from.vel[1], to.vel[1], alpha);
  a.vel.z = lerp(from.vel[2], to.vel[2], alpha);
  a.yaw = NETP.lerpAngle(from.yaw, to.yaw, alpha);
  a.pitch = lerp(from.pitch, to.pitch, alpha);
  a.aimYaw = NETP.lerpAngle(from.aimYaw, to.aimYaw, alpha);
  a.aimPitch = lerp(from.aimPitch, to.aimPitch, alpha);
  a.bodyYaw = NETP.lerpAngle(from.bodyYaw, to.bodyYaw, alpha);
}

function netSendEvent(kind, data) {
  if (!netIsHost() || NET.phase !== 'playing') return;
  if (NET.eventQueue.length >= 128) {
    const expendable = NET.eventQueue.findIndex(event =>
      event.kind === 'shot' || event.kind === 'shield');
    NET.eventQueue.splice(expendable >= 0 ? expendable : 0, 1);
  }
  NET.eventQueue.push(Object.assign({ id: ++NET.eventSeq, kind: kind }, data || {}));
}

function netOnAuthoritativeShot(a, w, lines) {
  netSendEvent('shot', { from: netActorId(a), weapon: w.id, lines: lines });
}
function netOnAuthoritativeShieldHit(target, from, x, y, z) {
  netSendEvent('shield', {
    target: netActorId(target), from: from ? netActorId(from) : null,
    at: [x, y, z]
  });
}
function netOnAuthoritativeDamage(target, from, damage, head, x, y, z) {
  netSendEvent('damage', {
    target: netActorId(target), from: from ? netActorId(from) : null,
    damage: netRound(damage), head: !!head, at: [x, y, z]
  });
}
function netOnAuthoritativeKill(target, from) {
  netSendEvent('kill', {
    target: netActorId(target), from: from ? netActorId(from) : null,
    streak: from ? from.streak : 0
  });
}
function netOnAuthoritativeRespawn(a) {
  netSendEvent('respawn', {
    actor: netActorId(a), at: [a.pos.x, a.pos.y, a.pos.z],
    color: a.colors.body
  });
}
function netOnAuthoritativeMatchOver(winner) {
  if (!netIsHost() || NET.phase !== 'playing') return;
  netSendEvent('match-over', { winner: netActorId(winner) });
  /* The winning simulation tick may be the last tick of the round. Send its
     state and queued events immediately, before telling the relay the room is
     back between rounds. WebSocket ordering makes this terminal update exact. */
  netAfterSimulation(0, true);
  netSend({
    t: 'lobby',
    v: NETP.VERSION,
    round: NET.round,
    winner: netActorId(winner)
  });
}

function netKnownActor(value) {
  return typeof value === 'string' && NET.actorManifest && NET.actorManifest.has(value);
}

function netEventPoint(value) {
  return Array.isArray(value) && value.length === 3 &&
    value.every(component => netFiniteIn(component, -200, 200));
}

function netValidEvent(e) {
  if (!e || typeof e !== 'object' || Array.isArray(e) ||
      !Number.isSafeInteger(e.id) || e.id < 1 ||
      typeof e.kind !== 'string') return false;
  if (e.kind === 'shot') {
    return netKnownActor(e.from) && !!WBY[e.weapon] &&
      Array.isArray(e.lines) && e.lines.length <= 16 &&
      e.lines.every(line => Array.isArray(line) && line.length === 6 &&
        line.every(component => netFiniteIn(component, -200, 200)));
  }
  if (e.kind === 'shield') {
    return netKnownActor(e.target) &&
      (e.from === null || netKnownActor(e.from)) && netEventPoint(e.at);
  }
  if (e.kind === 'damage') {
    return netKnownActor(e.target) &&
      (e.from === null || netKnownActor(e.from)) &&
      netFiniteIn(e.damage, 0, 500) && typeof e.head === 'boolean' &&
      netEventPoint(e.at);
  }
  if (e.kind === 'kill') {
    return netKnownActor(e.target) &&
      (e.from === null || netKnownActor(e.from)) && netSafeCount(e.streak);
  }
  if (e.kind === 'respawn') {
    return netKnownActor(e.actor) && netEventPoint(e.at) &&
      Number.isSafeInteger(e.color) && e.color >= 0 && e.color <= 0xffffff;
  }
  return e.kind === 'match-over' && netKnownActor(e.winner);
}

function netShowRemoteMatchOver(winnerId) {
  if (!G.started) return;
  const winner = G.actors.find(actor => actor.netId === winnerId);
  if (!winner) return;
  const first = !G.over;
  G.over = true;
  G.winner = winner;
  G.paused = false;
  document.getElementById('title').classList.add('off');
  const dead = document.getElementById('dead');
  dead.classList.add('off');
  delete dead.dataset.wasUp;
  showOverScreen(winner);
  if (first && winner === G.player) SFX.win();
  exitPointerLock();
}

function netApplyEvent(e) {
  if (!netValidEvent(e) || e.id <= NET.lastEventSeq) return;
  NET.lastEventSeq = e.id;
  const from = e.from ? G.actors.find(a => a.netId === e.from) : null;
  const target = e.target ? G.actors.find(a => a.netId === e.target) : null;

  if (e.kind === 'shot') {
    /* The guest already drew this shot from the same fireSeq-seeded spread.
       Replaying its authoritative event would duplicate an identical tracer;
       damage feedback still arrives only through the host's damage event. */
    if (e.from === NET.id) return;
    if (from) { from.recoil = 1; from.aiming = true; }
    const w = WBY[e.weapon] || WBY.smg;
    if (Array.isArray(e.lines)) {
      for (let i = 0; i < e.lines.length; i++) {
        const l = e.lines[i];
        if (!Array.isArray(l) || l.length !== 6 || !l.every(Number.isFinite)) continue;
        if (i === 0 || e.lines.length <= 3 || i % 3 === 0)
          fxTracer(l[0], l[1], l[2], l[3], l[4], l[5], C(from ? from.colors.trim : w.tracer));
      }
    }
    if (from) SFX.shoot(w.id, from.pos.x, from.pos.y + 1.3, from.pos.z);
  } else if (e.kind === 'shield') {
    if (target && Array.isArray(e.at)) fxShieldHit(target, e.at[0], e.at[1], e.at[2]);
  } else if (e.kind === 'damage') {
    if (e.from === NET.id && Array.isArray(e.at)) {
      SFX.hit(!!e.head);
      showHitmarker(!!e.head);
      addFloater(e.head ? Math.round(e.damage) + '!' : String(Math.round(e.damage)),
        e.at[0], e.at[1], e.at[2], e.head ? '#fff0a8' : '#ffffff', !!e.head);
    }
    if (e.target === NET.id) {
      SFX.hurt(); flashDamage(); fxShake(0.18);
      if (from) addDamageDir(from);
    }
  } else if (e.kind === 'kill') {
    if (target) addKillFeed(from, target);
    if (e.from === NET.id && target) {
      SFX.kill();
      addFloater('+1', target.pos.x, target.pos.y + 1.6, target.pos.z, '#b8f2d8', true);
      if (e.streak >= 3) showHint(e.streak + ' IN A ROW!');
    }
    if (e.target === NET.id) NET.lastKillerId = e.from;
  } else if (e.kind === 'respawn') {
    if (e.actor === NET.id) return;
    fxSpawnPuff(e.at[0], e.at[1], e.at[2], C(e.color));
  } else if (e.kind === 'match-over') {
    netShowRemoteMatchOver(e.winner);
  }
}

function initNetworkUI() {
  const name = document.getElementById('playerName');
  if (name) {
    let saved = '';
    try { saved = localStorage.getItem('pastel-nuketown-name') || ''; } catch (e) {}
    name.value = NETP.cleanPlayerName(saved || ('PLAYER ' + randi(10, 99)));
    name.addEventListener('change', () => { name.value = NETP.cleanPlayerName(name.value); });
  }
  const roomInput = document.getElementById('roomCode');
  const invited = NETP.normalizeRoomCode(QS.get('room') || '');
  if (roomInput && invited) roomInput.value = invited;
  const note = document.getElementById('menuNote');
  if (note && invited) note.textContent = 'Invite detected — enter a name and join ' + invited + '.';

  document.getElementById('hostGame').addEventListener('click', () => netConnect('create'));
  document.getElementById('joinGame').addEventListener('click', () => netConnect('join', roomInput.value));

  const refresh = document.getElementById('refreshRooms');
  if (refresh) refresh.addEventListener('click', () => netRefreshRooms(true));
  netRefreshRooms(true);
  /* Poll only while the setup menu is actually on screen — netRefreshRooms
     bails out on its own once the match starts or the pause card is up. */
  NET.roomsTimer = setInterval(() => netRefreshRooms(false), 5000);

  roomInput.addEventListener('input', () => {
    roomInput.value = NETP.normalizeRoomCode(roomInput.value);
  });
  roomInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') netConnect('join', roomInput.value);
  });
  document.getElementById('netStart').addEventListener('click', netHostStart);
  document.getElementById('netLeave').addEventListener('click', netLeaveLobby);
  document.getElementById('copyRoom').addEventListener('click', async () => {
    const u = new URL(location.href);
    u.searchParams.set('room', NET.room);
    u.searchParams.delete('autostart');
    try {
      await navigator.clipboard.writeText(u.toString());
      netStatus('Invite link copied!');
    } catch (e) {
      netStatus('Room code: ' + NET.room);
    }
  });
}
