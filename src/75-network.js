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
/* Events leave on their own clock so hit feedback does not wait for the next
   snapshot. Faster than snapshots because they are small and latency-critical,
   but not once per 60Hz tick: the relay closes a peer over 90 messages a
   second, and snapshots already claim 20 of those. */
const NET_EVENT_INTERVAL = 1 / 30;
const NET_CHECKPOINT_INTERVAL = 1;
/* One recorded step per simulated tick; a second of them is far more than the
   round trip a replay ever has to cover, and bounds the buffer if the socket
   stalls. */
const NET_MAX_PENDING_STEPS = 120;
/* Bounded so a guest that stalls and then floods cannot make the host work
   through a backlog of stale intent. Overflow drops the oldest: being current
   matters more than being complete. */
const NET_MAX_INPUT_QUEUE = 6;
/* Past this the replay landed somewhere unrelated to the screen -- a respawn,
   not a misprediction -- and easing into it would drag the body across the
   map. */
const NET_SNAP_DISTANCE = 3;
/* How much of a small residual to leave on screen for the next frame to
   absorb. Low, because the residual is now nearly always zero. */
const NET_RESIDUAL_SMOOTHING = 0.5;
const NET_MAX_HISTORY_SAMPLES = 32;
const NET_MAX_REPLICA_SAMPLES = 16;
/* Long enough that a host keeping a seat for one more friend has time to say
   so, short enough that two strangers are not left reading a roster. */
const NET_AUTOSTART_SECONDS = 15;
/* Nobody else is arriving into a full room, so stop pretending to wait. */
const NET_AUTOSTART_FULL_SECONDS = 5;
/* Errors that mean "not that room" rather than "not this game". A quick-play
   candidate can fill, close or start in the moment between the poll that
   offered it and the socket that dials it; that is the next candidate's turn,
   not a failure to report. */
const NET_QUICK_RETRY_ERRORS = ['room-not-found', 'room-full', 'match-started'];
const NET = {
  mode: 'solo',                 // solo | connecting | host | guest
  phase: 'idle',                // idle | connecting | lobby | playing
  socket: null,
  room: '',
  id: '',
  members: [],
  authorityEpoch: 0,
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
  checkpointAcc: 0,
  checkpointDirty: false,
  eventAcc: 0,
  pendingSteps: [],
  lastResidual: 0,
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
  predictedHits: [],
  arrivalJitter: 0,
  lastSnapshotAt: 0,
  actorManifest: null,
  manifestVersion: 1,
  lastRawSnapshot: null,
  lastCheckpoint: null,
  migration: null,
  lastKillerId: null,
  scoreSignature: '',
  connectTimer: 0,
  roomsBusy: false,
  roomsTimer: 0,
  quick: null,                  // in-flight quick-play plan, or null
  countdown: 0,
  countdownTimer: 0,
  autoStartHeld: false
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

/* Blank unless there is genuinely someone to play with. An unreachable or
   too-old server has nothing to report, and "0 players online" would hang a
   sign saying the game is dead right above the button that revives it —
   solo players are invisible here, so an empty relay is the normal case. */
function netRenderOnline(count) {
  const el = document.getElementById('onlineCount');
  if (!el) return;
  el.textContent = typeof count === 'number' && count >= 2
    ? count + ' players online'
    : '';
}

function netRenderRooms(rooms, message) {
  const list = document.getElementById('roomList');
  if (!list) return;
  list.innerHTML = '';

  if (!rooms || !rooms.length) {
    const empty = document.createElement('li');
    empty.className = 'rooms-empty';
    empty.textContent = message || 'Nothing running — press PLAY to open a room.';
    list.appendChild(empty);
    return;
  }

  for (const room of rooms) {
    const li = document.createElement('li');
    if (room.inProgress) li.className = 'busy';

    const code = document.createElement('strong');
    code.textContent = room.code;
    li.appendChild(code);

    const host = document.createElement('span');
    host.textContent = room.host;
    li.appendChild(host);

    const seats = document.createElement('b');
    seats.textContent = room.players + '/' + room.max;
    li.appendChild(seats);

    /* A running room is shown for the population it proves, not the seat it
       cannot offer, so it gets a label where the others get a button. */
    if (room.inProgress) {
      const tag = document.createElement('b');
      tag.className = 'tag';
      tag.textContent = 'IN PROGRESS';
      li.appendChild(tag);
    } else {
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
    }

    list.appendChild(li);
  }
}

/* One fetch, two callers: the menu poller repaints the browser with it and
   quick play chooses from it. Quick play deliberately does not reuse the
   poller's last answer — a five-second-old list is old enough to send someone
   at a room that has already filled or started. */
function netFetchRooms() {
  const url = netRoomsURL();
  if (!url || typeof fetch !== 'function')
    return Promise.reject(new Error('no room server'));

  const control = typeof AbortController === 'function' ? new AbortController() : null;
  const bail = control ? setTimeout(() => control.abort(), 4000) : 0;
  const done = () => { if (bail) clearTimeout(bail); };

  return fetch(url, { cache: 'no-store', signal: control ? control.signal : undefined })
    .then(response => (response.ok ? response.json() : Promise.reject(response.status)))
    .then(body => {
      done();
      return {
        rooms: NETP.cleanRoomSummaries(body && body.rooms, NETP.MAX_ROOM_LIST),
        online: body && body.online
      };
    }, error => {
      done();
      return Promise.reject(error);
    });
}

function netRefreshRooms(manual) {
  if (NET.roomsBusy) return;
  if (!manual && !netRoomsPanelOpen()) return;

  const url = netRoomsURL();
  if (!url) {
    netRenderRooms(null, 'The multiplayer server address is invalid.');
    return;
  }

  NET.roomsBusy = true;
  netFetchRooms()
    .then(result => {
      /* A refresh that lands after the player has already left the menu must
         not repaint a list they can no longer act on. */
      if (netRoomsPanelOpen()) netRenderRooms(result.rooms);
      netRenderOnline(result.online);
    })
    .catch(() => {
      if (netRoomsPanelOpen())
        netRenderRooms(null, 'No room server reachable.');
      netRenderOnline(null);
    })
    .then(() => { NET.roomsBusy = false; });
}

/* PLAY is the entire matchmaking interface for anyone who does not care what a
   room is: take the busiest one with a seat free, and open one when there is
   nothing to join. Fullest-first on purpose — a thin population belongs in one
   match rather than scattered across four rooms of one. */
function netQuickPlay() {
  if (NET.phase === 'connecting' || netIsMultiplayer()) return;

  netSetMenuBusy(true);
  netStatus('Finding a match…');
  netRenderRooms(null, 'Looking for a match…');

  netFetchRooms()
    .then(result => {
      if (NET.phase === 'connecting') return;
      if (netRoomsPanelOpen()) netRenderRooms(result.rooms);
      netRenderOnline(result.online);
      netQuickNext({ candidates: netQuickCandidates(result.rooms) });
    })
    .catch(() => {
      /* Failing to browse is not the same as failing to play: creating a room
         still works on a relay that just missed an HTTP poll, and if it really
         is down, the socket says so in one clear sentence instead of two. */
      if (NET.phase !== 'connecting') netQuickNext({ candidates: [] });
    });
}

function netQuickCandidates(rooms) {
  return (rooms || [])
    .filter(room => !room.inProgress && room.players < room.max)
    .sort((a, b) => b.players - a.players)
    .map(room => room.code);
}

function netQuickNext(plan) {
  const code = plan.candidates.shift();
  if (code) {
    netStatus('Joining ' + code + '…');
    netConnect('join', code, plan);
    return;
  }
  plan.creating = true;
  netStatus('Opening a room…');
  netConnect('create', '', plan);
}

function netSetMenuBusy(busy) {
  for (const id of ['quickPlay', 'hostGame', 'joinGame', 'play']) {
    const el = document.getElementById(id);
    if (el) el.disabled = !!busy;
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
      netRenderOnline(body && body.online);
    })
    .catch(() => {
      if (netRoomsPanelOpen())
        netRenderRooms(null, 'No room server reachable.');
      netRenderOnline(null);
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
  netUpdateAutoStart();
}

function netShowMainMenu(message) {
  const menu = document.getElementById('menu');
  const lobby = document.getElementById('lobby');
  if (menu) { menu.hidden = false; menu.classList.remove('pause'); }
  if (lobby) lobby.hidden = true;
  const play = document.getElementById('play');
  if (play) play.textContent = 'SOLO';
  netSetMenuBusy(false);
  const note = document.getElementById('menuNote');
  if (note) note.textContent = message ||
    'PLAY finds you a room with people in it. SOLO is you and eight bots.';
  netRefreshRooms(true);
}

/* ---- automatic start ----------------------------------------------------
   The lobby used to wait on a person: guests sat until the host clicked, and a
   host who wandered off froze everyone behind them. It now waits on a clock
   the host can stop, and START MATCH is left for the impatient. */

function netAutoStartSeconds() {
  return NET.members.length >= (NETP ? NETP.MAX_PLAYERS : 4)
    ? NET_AUTOSTART_FULL_SECONDS
    : NET_AUTOSTART_SECONDS;
}

function netCancelAutoStart(held) {
  if (NET.countdownTimer) clearInterval(NET.countdownTimer);
  NET.countdownTimer = 0;
  NET.countdown = 0;
  if (held) NET.autoStartHeld = true;
  netRenderCountdown();
}

function netUpdateAutoStart() {
  if (!netIsHost() || NET.phase !== 'lobby' || NET.autoStartHeld ||
      NET.members.length < 2) {
    netCancelAutoStart();
    return;
  }

  const seconds = netAutoStartSeconds();
  /* A room filling up shortens the wait but never lengthens it: whoever is
     already watching the number count down should not see it jump back up. */
  if (!NET.countdownTimer) {
    NET.countdown = seconds;
    NET.countdownTimer = setInterval(netTickAutoStart, 1000);
  } else if (seconds < NET.countdown) {
    NET.countdown = seconds;
  }
  netRenderCountdown();
}

function netTickAutoStart() {
  if (!netIsHost() || NET.phase !== 'lobby' || NET.members.length < 2) {
    netCancelAutoStart();
    return;
  }
  NET.countdown--;
  if (NET.countdown > 0) {
    netRenderCountdown();
    return;
  }
  netCancelAutoStart();
  netHostStart();
}

function netRenderCountdown() {
  const wrap = document.getElementById('lobbyCountdown');
  const text = document.getElementById('countdownText');
  const hold = document.getElementById('holdStart');
  if (!wrap || !text) return;

  const show = (message, holdable) => {
    text.textContent = message;
    if (hold) hold.hidden = !holdable;
    wrap.hidden = false;
  };

  if (!netIsMultiplayer() || NET.phase !== 'lobby') {
    wrap.hidden = true;
    return;
  }
  if (!netIsHost()) {
    /* A guest cannot see the host's clock without a message this protocol
       version does not have, but it can be told the rule instead of being left
       to watch a roster that never moves. */
    show('Waiting for the host — matches start on their own.', false);
    return;
  }
  if (NET.countdownTimer) {
    show('Starting in ' + NET.countdown + '…', true);
    return;
  }
  if (NET.autoStartHeld && NET.members.length >= 2) {
    show('Auto-start held — press START MATCH when you are ready.', false);
    return;
  }
  wrap.hidden = true;
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
  NET.authorityEpoch = 0;
  NET.round = 0;
  NET.wanted = null;
  NET.starting = false;
  NET.inputSeq = 0;
  NET.lastFireSeqSent = 0;
  NET.inputSentTimes.clear();
  NET.weaponSeq = 0;
  NET.lastInputAck = 0;
  NET.snapshotAcc = 0;
  NET.checkpointAcc = 0;
  NET.checkpointDirty = false;
  NET.eventAcc = 0;
  NET.pendingSteps = [];
  NET.lastResidual = 0;
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
  NET.predictedHits = [];
  NET.arrivalJitter = 0;
  NET.lastSnapshotAt = 0;
  NET.actorManifest = null;
  NET.manifestVersion = 1;
  NET.lastRawSnapshot = null;
  NET.lastCheckpoint = null;
  NET.migration = null;
  NET.lastKillerId = null;
  NET.scoreSignature = '';
  NET.quick = null;
  NET.autoStartHeld = false;
  netCancelAutoStart();
  NET.manualClose = false;
}

function netConnect(kind, requestedRoom, quickPlan) {
  if (!NETP || typeof WebSocket !== 'function') {
    netStatus('Multiplayer is not supported in this browser.', 'error');
    netSetMenuBusy(false);
    return;
  }
  const nameEl = document.getElementById('playerName');
  const name = NETP.cleanPlayerName(nameEl && nameEl.value);
  if (nameEl) nameEl.value = name;
  try { localStorage.setItem('pastel-nuketown-name', name); } catch (e) {}
  const room = NETP.normalizeRoomCode(requestedRoom || '');
  if (kind === 'join' && room.length !== 6) {
    netStatus('Enter the six-character room code.', 'error');
    netSetMenuBusy(false);
    return;
  }

  const listedEl = document.getElementById('roomPublic');
  const listed = !listedEl || !!listedEl.checked;

  netResetTransport();
  NET.mode = 'connecting';
  NET.phase = 'connecting';
  NET.wanted = { kind, name, room, listed };
  /* Reinstalled after the reset: a quick-play run outlives the individual
     connection attempts it is made of. */
  NET.quick = quickPlan || null;
  if (!NET.quick)
    netStatus(kind === 'create' ? 'Creating room…' : 'Finding room ' + room + '…');
  netSetMenuBusy(true);

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
    netSetMenuBusy(false);
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
        !NETP.isAuthorityEpoch(msg.authorityEpoch) ||
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
    NET.authorityEpoch = msg.authorityEpoch;
    /* Adopt the room's round at the handshake. Joining a room that has
       already played a round leaves NET.round behind otherwise, and every
       subsequent `start` looks like it skipped ahead and gets ignored. */
    NET.round = Number.isSafeInteger(msg.round) && msg.round >= 0 ? msg.round : 0;
    /* Whether this room was chosen or fallen back to changes what the host
       needs to hear, and the plan is finished either way. */
    const opened = !!NET.quick && !!NET.quick.creating;
    NET.quick = null;
    netShowLobby();
    netStatus(netIsHost()
      ? (opened
          ? 'Nothing to join, so this room is yours — copy the invite, or start now with bots.'
          : 'Room ready — share the code, then start.')
      : 'Joined ' + NET.room + '.');
    return;
  }
  if (msg.t === 'host-changed') {
    if (!netIsMultiplayer()) return;
    const previousEpoch = NET.authorityEpoch;
    const checked = NETP.sanitizeHostChanged(
      msg, NET.id, NET.authorityEpoch, NET.round);
    if (!checked.ok) return;
    const change = checked.value;
    NET.authorityEpoch = change.authorityEpoch;
    NET.round = change.round;
    NET.members = change.members;
    NET.mode = change.host === NET.id ? 'host' : 'guest';
    NET.starting = false;
    if (change.seamless) {
      if (!netBeginSeamlessMigration(change, previousEpoch))
        netEndSession('Host migration state was unsafe. Reconnect to continue.');
    } else {
      NET.phase = 'lobby';
      netReturnToLobbyAfterHostChange(change.host);
    }
    return;
  }
  if (msg.t === 'authority-state' && netIsHost() && NET.phase === 'migrating' &&
      msg.authorityEpoch === NET.authorityEpoch && msg.round === NET.round) {
    netAcceptAuthorityState(msg);
    return;
  }
  if (msg.t === 'authority-ready' && NET.phase === 'migrating' &&
      msg.authorityEpoch === NET.authorityEpoch && msg.round === NET.round &&
      msg.host === NET.members.find(member => member.role === 'host')?.id) {
    netFinishSeamlessMigration();
    return;
  }
  if (msg.t === 'members') {
    const members = netCleanMembers(msg.members);
    if (!netIsMultiplayer() || !members || !members.some(member => member.id === NET.id)) return;
    NET.members = members;
    netRenderMembers();
    netUpdateAutoStart();
    if (NET.phase === 'migrating' && netIsHost()) {
      const liveGuests = new Set(
        members.filter(member => member.id !== NET.id).map(member => member.id));
      for (const id of NET.migration.expected)
        if (!liveGuests.has(id)) NET.migration.expected.delete(id);
      netPruneDepartedPlayers();
      netMaybeAuthorityReady();
    }
    if (netIsHost() && NET.phase === 'playing') netPruneDepartedPlayers();
    return;
  }
  if (msg.t === 'start') {
    const members = netCleanMembers(msg.members);
    /* Rounds only ever move forward. Requiring exactly +1 breaks any client
       whose baseline came from the handshake rather than from round 1. */
    if (!netIsMultiplayer() || !Number.isSafeInteger(msg.round) ||
        msg.authorityEpoch !== NET.authorityEpoch ||
        msg.round <= NET.round || !members ||
        !members.some(member => member.id === NET.id)) return;
    NET.round = msg.round;
    NET.members = members;
    NET.starting = false;
    netBeginMatch();
    return;
  }
  if (msg.t === 'lobby' && netIsGuest() && NET.phase === 'playing' &&
      msg.authorityEpoch === NET.authorityEpoch && msg.round === NET.round) {
    netShowRemoteMatchOver(typeof msg.winner === 'string' ? msg.winner : null);
    return;
  }
  if (msg.t === 'input' && netIsHost() && NET.phase === 'playing' &&
      msg.authorityEpoch === NET.authorityEpoch &&
      msg.round === NET.round && typeof msg.from === 'string') {
    const a = G.actors.find(x => x.controller === 'remote' && x.netId === msg.from);
    if (!a) return;
    const checked = NETP.sanitizeInput(msg, a.lastInputSeq, a.lastWeaponSeq);
    if (!checked.ok) return;
    /* Queued rather than assigned. A guest now sends one input per simulated
       tick, and jitter means two can land between two host ticks; overwriting
       would silently drop one, and a dropped input is one the guest predicted
       with and the authority never applied -- exactly the disagreement that
       replay exists to remove. */
    if (!a.netInputQueue) a.netInputQueue = [];
    a.netInputQueue.push(checked.value);
    if (a.netInputQueue.length > NET_MAX_INPUT_QUEUE)
      a.netInputQueue.splice(0, a.netInputQueue.length - NET_MAX_INPUT_QUEUE);
    a.netInput = checked.value;
    a.lastInputSeq = checked.value.seq;
    a.lastWeaponSeq = checked.value.weaponSeq;
    a.netInputAt = G.time;
    return;
  }
  if (msg.t === 'snapshot' && netIsGuest() && NET.phase === 'playing' &&
      msg.authorityEpoch === NET.authorityEpoch && msg.round === NET.round) {
    netApplySnapshot(msg);
    return;
  }
  if (msg.t === 'checkpoint' && netIsGuest() && NET.phase === 'playing' &&
      msg.authorityEpoch === NET.authorityEpoch && msg.round === NET.round &&
      netValidCheckpoint(msg)) {
    NET.lastCheckpoint = msg;
    return;
  }
  if (msg.t === 'event' && netIsGuest() && NET.phase === 'playing' &&
      msg.authorityEpoch === NET.authorityEpoch &&
      msg.round === NET.round && Array.isArray(msg.events) && msg.events.length <= 256) {
    for (const event of msg.events) netApplyEvent(event);
    return;
  }
  if (msg.t === 'error') {
    const errorText = typeof msg.message === 'string' && msg.message
      ? msg.message.slice(0, 200)
      : 'Multiplayer error.';
    NET.starting = false;
    if (NET.phase === 'connecting') {
      const plan = NET.quick;
      /* Only a join can be retried elsewhere. A create that fails failed for a
         reason the next attempt would hit too. */
      const retry = !!plan && !plan.creating &&
        NET_QUICK_RETRY_ERRORS.indexOf(msg.code) !== -1;
      netResetTransport();
      if (retry) {
        netQuickNext(plan);
        return;
      }
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
  if (!netSend({
    t: 'start',
    v: NETP.VERSION,
    authorityEpoch: NET.authorityEpoch
  })) {
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
  netCancelAutoStart();
  NET.inputSeq = 0;
  NET.lastFireSeqSent = 0;
  NET.inputSentTimes.clear();
  NET.weaponSeq = 0;
  NET.lastInputAck = 0;
  NET.snapshotAcc = 0;
  NET.checkpointAcc = 0;
  NET.checkpointDirty = true;
  NET.eventAcc = 0;
  NET.pendingSteps = [];
  NET.lastResidual = 0;
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
  NET.predictedHits = [];
  NET.arrivalJitter = 0;
  NET.lastSnapshotAt = 0;
  NET.actorManifest = null;
  NET.manifestVersion = 1;
  NET.lastRawSnapshot = null;
  NET.lastCheckpoint = null;
  NET.migration = null;
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

function netReturnToLobbyAfterHostChange(hostId) {
  if (G.started) {
    G.paused = true;
    G.fixedAcc = 0;
    exitPointerLock();
    document.getElementById('hud').classList.add('hide');
    document.getElementById('dead').classList.add('off');
    document.getElementById('over').classList.add('off');
    restoreBoard();
    G.started = false;
    G.over = false;
    G.winner = null;
  }
  const menu = document.getElementById('menu');
  if (menu) menu.classList.remove('pause');
  document.getElementById('title').classList.remove('off');
  netShowLobby();

  const promoted = hostId === NET.id;
  const host = NET.members.find(member => member.id === hostId);
  netStatus(promoted
    ? 'The previous host left. You are the new host — start a fresh round.'
    : ((host ? host.name : 'A player') + ' is the new host. Waiting for a fresh round.'));
}

function netValidMigrationSnapshot(snapshot, previousEpoch, round) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot) ||
      snapshot.t !== 'snapshot' || snapshot.v !== NETP.VERSION ||
      snapshot.authorityEpoch !== previousEpoch || snapshot.round !== round ||
      !Number.isSafeInteger(snapshot.tick) || snapshot.tick < 0 ||
      !netFiniteIn(snapshot.time, 0, 100_000_000) ||
      !Number.isSafeInteger(snapshot.eventSeq) || snapshot.eventSeq < 0 ||
      !Number.isSafeInteger(snapshot.manifestVersion) ||
      snapshot.manifestVersion < 1 || typeof snapshot.over !== 'boolean' ||
      !Array.isArray(snapshot.actors) || snapshot.actors.length < 1 ||
      snapshot.actors.length > 16) return false;
  const ids = new Set();
  for (const actor of snapshot.actors) {
    if (!netValidActorState(actor) || ids.has(actor.netId)) return false;
    ids.add(actor.netId);
  }
  if (!ids.has(NET.id)) return false;
  if (snapshot.winner !== null &&
      (typeof snapshot.winner !== 'string' || !ids.has(snapshot.winner))) return false;
  if (snapshot.over &&
      (typeof snapshot.winner !== 'string' || !ids.has(snapshot.winner))) return false;
  return true;
}

function netCheckpointMetadata(checkpoint) {
  return new Map(checkpoint.actors.map(actor => [actor.netId, actor]));
}

function netBotOrdinal(netId) {
  const match = /^bot-([1-9]\d*)$/.exec(netId);
  return match ? Number(match[1]) - 1 : null;
}

function netRestoreAmmoStore(actor, metadata) {
  actor._ammoBy = {};
  for (const weapon of Object.keys(metadata.ammoBy)) {
    const value = metadata.ammoBy[weapon];
    actor._ammoBy[weapon] = { ammo: value[0], reserve: value[1] };
  }
  actor._ammoBy[actor.weapon] = { ammo: actor.ammo, reserve: actor.reserve };
}

function netHydrateActor(actor, state, metadata, local) {
  actor.id = state.id;
  actor.netId = state.netId;
  actor.name = NETP.cleanPlayerName(state.name);
  actor.isPlayer = local;
  actor.isHuman = !!state.human;
  actor.controller = local ? 'local' : (state.human ? 'remote' : 'bot');
  actor.skill = metadata.skill;
  actor.colors = {
    body: state.colors.body, trim: state.colors.trim, name: state.colors.name
  };
  actor.pos.x = state.pos[0]; actor.pos.y = state.pos[1]; actor.pos.z = state.pos[2];
  actor.vel.x = state.vel[0]; actor.vel.y = state.vel[1]; actor.vel.z = state.vel[2];
  actor.yaw = state.yaw; actor.pitch = state.pitch;
  actor.aimYaw = state.aimYaw; actor.aimPitch = state.aimPitch;
  actor.bodyYaw = state.bodyYaw;
  actor.onGround = !!state.onGround;
  actor.aiming = !!state.aiming;
  actor.health = state.health; actor.maxHealth = state.maxHealth;
  actor.alive = !!state.alive;
  actor.deathT = state.deathT; actor.respawnT = state.respawnT;
  actor.shield = state.shield;
  actor.weapon = state.weapon;
  actor.ammo = state.ammo; actor.reserve = state.reserve;
  actor.reloadT = state.reloadT;
  actor.fireCd = 0;
  actor.kills = state.kills; actor.deaths = state.deaths;
  actor.streak = state.streak; actor.bestStreak = state.bestStreak;
  actor.lastHitBy = state.lastHitBy;
  actor.stepPhase = 0;
  actor.pendingFireUntil = 0;
  actor.pendingFireSeq = 0;
  actor.pendingRenderTime = 0;
  actor.netInput = null;
  actor.netInputQueue = [];
  actor.lastInputSeq = -1;
  actor.lastWeaponSeq = -1;
  actor.inputAck = 0;
  actor.weaponAck = 0;
  actor.lastFireSeq = 0;
  actor.lastReloadSeq = 0;
  actor.netHistory = [];
  actor.netSamples = [];
  netRestoreAmmoStore(actor, metadata);

  if (actor.controller === 'bot') {
    const ordinal = netBotOrdinal(actor.netId);
    actor.brain = G.aiOK && ordinal !== null
      ? AI.createBrain({
        id: actor.id,
        seed: 1000 + ordinal * 77,
        skill: actor.skill
      })
      : null;
  } else {
    actor.brain = null;
  }
}

function netHydrateMigration(snapshot, checkpoint) {
  const metadata = netCheckpointMetadata(checkpoint);
  const members = new Set(NET.members.map(member => member.id));
  const oldActors = G.actors.slice();
  const restored = [];
  const manifest = new Set();
  let pruned = false;

  for (const state of snapshot.actors) {
    const slow = metadata.get(state.netId);
    if (!slow) return false;
    if ((state.human && (slow.controller === 'bot' || !slow.human)) ||
        (!state.human && (slow.controller !== 'bot' || slow.human))) return false;
    if (state.human && !members.has(state.netId)) {
      pruned = true;
      continue;
    }
    const local = state.netId === NET.id;
    let actor = local ? G.player : oldActors.find(item => item.netId === state.netId);
    if (!actor) {
      actor = makeActor({
        id: state.id,
        netId: state.netId,
        name: NETP.cleanPlayerName(state.name),
        controller: state.human ? 'remote' : 'bot',
        isHuman: !!state.human,
        colors: {
          body: state.colors.body, trim: state.colors.trim, name: state.colors.name
        },
        weapon: state.weapon,
        skill: slow.skill
      });
      attachCharacter(actor);
    }
    netHydrateActor(actor, state, slow, local);
    restored.push(actor);
    manifest.add(state.netId);
  }
  if (!manifest.has(NET.id)) return false;
  for (const actor of oldActors) {
    if (!restored.includes(actor)) disposeActorVisuals(actor);
  }
  G.actors = restored;
  G.player = restored.find(actor => actor.netId === NET.id);
  _nextId = restored.reduce((max, actor) => Math.max(max, actor.id), 0) + 1;
  G.time = snapshot.time;
  G.tick = snapshot.tick;
  G.over = snapshot.over;
  G.winner = snapshot.winner
    ? restored.find(actor => actor.netId === snapshot.winner) || null
    : null;
  if (snapshot.over && !G.winner) return false;
  G.fixedAcc = 0;

  NET.actorManifest = manifest;
  NET.manifestVersion = snapshot.manifestVersion + (pruned ? 1 : 0);
  NET.lastRawSnapshot = snapshot;
  NET.lastCheckpoint = checkpoint;
  NET.lastSnapshotTick = snapshot.tick;
  NET.lastSnapshotTime = snapshot.time;
  NET.hostClock = snapshot.time;
  NET.hostClockAt = performance.now() / 1000;
  NET.pendingSteps = [];
  NET.inputSentTimes.clear();
  NET.lastInputAck = NET.inputSeq;
  NET.eventSeq = Math.max(
    snapshot.eventSeq,
    ...checkpoint.events.map(event => event.id)
  );
  NET.eventQueue = netIsHost()
    ? checkpoint.events.filter(event => netValidEvent(event, manifest))
    : [];
  NET.checkpointDirty = pruned;
  NET.snapshotAcc = 0;
  NET.checkpointAcc = 0;
  NET.eventAcc = 0;
  NET.lastResidual = 0;

  if (G.player) vmSetWeapon(G.player.weapon);
  refreshBoard();
  updateHUD();
  return true;
}

function netSendAuthorityState() {
  if (!netIsGuest() || NET.phase !== 'migrating' || !G.player) return;
  const state = NET.migration.authorityState;
  netSend({
    t: 'authority-state',
    v: NETP.VERSION,
    authorityEpoch: NET.authorityEpoch,
    round: NET.round,
    inputSeq: state.inputSeq,
    fireSeq: state.fireSeq,
    reloadSeq: state.reloadSeq,
    weaponSeq: state.weaponSeq,
    weapon: state.weapon
  });
}

function netBeginSeamlessMigration(change, previousEpoch) {
  const snapshot = change.snapshot;
  const checkpoint = change.checkpoint;
  const sourceEpoch = snapshot && snapshot.authorityEpoch;
  if (!NETP.isAuthorityEpoch(sourceEpoch) ||
      sourceEpoch >= change.authorityEpoch ||
      sourceEpoch > previousEpoch ||
      (NET.lastRawSnapshot && NET.lastRawSnapshot.round === change.round &&
       snapshot.tick < NET.lastRawSnapshot.tick) ||
      (NET.lastCheckpoint && NET.lastCheckpoint.round === change.round &&
       checkpoint.tick < NET.lastCheckpoint.tick) ||
      !netValidMigrationSnapshot(snapshot, sourceEpoch, change.round) ||
      !netValidCheckpoint(checkpoint) ||
      checkpoint.authorityEpoch !== sourceEpoch ||
      checkpoint.round !== change.round ||
      checkpoint.manifestVersion !== snapshot.manifestVersion) return false;
  const metadata = netCheckpointMetadata(checkpoint);
  if (metadata.size !== snapshot.actors.length ||
      snapshot.actors.some(actor => !metadata.has(actor.netId))) return false;

  NET.phase = 'migrating';
  NET.migration = {
    paused: G.paused,
    frozen: G.frozen,
    expected: new Set(
      change.members.filter(member => member.id !== NET.id).map(member => member.id)),
    received: new Set(),
    readySent: false,
    authorityState: {
      inputSeq: NET.inputSeq,
      fireSeq: IN.fireSeq,
      reloadSeq: IN.reloadSeq,
      weaponSeq: NET.weaponSeq,
      weapon: G.player.weapon
    }
  };
  G.frozen = true;
  G.fixedAcc = 0;
  if (!netHydrateMigration(snapshot, checkpoint)) return false;
  if (netIsHost()) netMaybeAuthorityReady();
  else netSendAuthorityState();
  netStatus(netIsHost()
    ? 'Taking over the current round…'
    : 'The host changed — resuming the current round…');
  return true;
}

function netAcceptAuthorityState(message) {
  if (!NET.migration || typeof message.from !== 'string' ||
      !NET.migration.expected.has(message.from)) return;
  const checked = NETP.sanitizeAuthorityState(message);
  if (!checked.ok) return;
  const actor = G.actors.find(item =>
    item.controller === 'remote' && item.netId === message.from);
  if (!actor) return;
  const state = checked.value;
  actor.lastInputSeq = state.inputSeq;
  actor.inputAck = state.inputSeq;
  actor.lastFireSeq = state.fireSeq;
  actor.lastReloadSeq = state.reloadSeq;
  actor.lastWeaponSeq = state.weaponSeq;
  actor.weaponAck = state.weaponSeq;
  if (actor.weapon !== state.weapon) switchRemoteWeapon(actor, state.weapon);
  actor.netInput = {
    fwd: 0, strafe: 0, jump: false, sprint: false, fire: false,
    fireSeq: state.fireSeq, reloadSeq: state.reloadSeq,
    yaw: actor.yaw, pitch: actor.pitch, weapon: actor.weapon,
    seq: state.inputSeq, weaponSeq: state.weaponSeq, renderTime: G.time
  };
  actor.netInputAt = G.time;
  NET.migration.received.add(message.from);
  netMaybeAuthorityReady();
}

function netMaybeAuthorityReady() {
  if (!netIsHost() || NET.phase !== 'migrating' || !NET.migration ||
      NET.migration.readySent) return;
  for (const id of NET.migration.expected)
    if (!NET.migration.received.has(id)) return;
  NET.migration.readySent = netSend({
    t: 'authority-ready',
    v: NETP.VERSION,
    authorityEpoch: NET.authorityEpoch,
    round: NET.round,
    tick: G.tick
  });
}

function netFinishSeamlessMigration() {
  if (!NET.migration) return;
  const migration = NET.migration;
  NET.migration = null;
  NET.phase = 'playing';
  G.frozen = migration.frozen;
  G.paused = migration.paused;
  G.fixedAcc = 0;
  NET.lastSnapshotAt = performance.now() / 1000;
  NET.hostClockAt = NET.lastSnapshotAt;
  netStatus('');
  showHint(netIsHost() ? 'YOU ARE THE HOST' : 'HOST MIGRATION COMPLETE');
  if (netIsHost()) netAfterSimulation(0, true);
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
  let changed = false;
  for (const a of G.actors.slice()) {
    if (a.controller === 'remote' && !live.has(a.netId)) {
      detachActor(a);
      changed = true;
    }
  }
  if (changed && netIsHost()) {
    NET.manifestVersion++;
    NET.checkpointDirty = true;
  }
  refreshBoard();
}

function netActorId(a) {
  return a && (a.netId || ('actor-' + a.id));
}

function netOnLocalWeaponChanged() {
  if (netIsGuest()) NET.weaponSeq++;
  if (netIsHost()) NET.checkpointDirty = true;
}

function netOnAuthoritySlowStateChanged() {
  if (netIsHost()) NET.checkpointDirty = true;
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

function netPackCheckpointActor(a) {
  const ammoBy = {};
  const stored = a._ammoBy && typeof a._ammoBy === 'object' ? a._ammoBy : {};
  for (const weapon of NETP.ALLOWED_WEAPONS) {
    const value = stored[weapon];
    if (value && netSafeCount(value.ammo) && netSafeCount(value.reserve))
      ammoBy[weapon] = [value.ammo, value.reserve];
  }
  ammoBy[a.weapon] = [Math.max(0, Math.floor(a.ammo)), Math.max(0, Math.floor(a.reserve))];
  return {
    netId: netActorId(a),
    controller: a.controller,
    human: !!a.isHuman,
    skill: a.skill || 'normal',
    ammoBy: ammoBy
  };
}

function netSendCheckpoint() {
  if (!netIsHost() || NET.phase !== 'playing' || !netSocketOpen()) return false;
  return netSend({
    t: 'checkpoint',
    v: NETP.VERSION,
    authorityEpoch: NET.authorityEpoch,
    round: NET.round,
    tick: G.tick,
    time: G.time,
    manifestVersion: NET.manifestVersion,
    actors: G.actors.map(netPackCheckpointActor),
    events: NET.eventQueue.slice()
  });
}

function netFlushEvents() {
  if (!NET.eventQueue.length) return;
  const events = NET.eventQueue.splice(0, NET.eventQueue.length);
  netSend({
    t: 'event',
    v: NETP.VERSION,
    authorityEpoch: NET.authorityEpoch,
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
  /* Once per simulated tick, so the host consumes input at exactly the rate
     the guest predicted with. */
  if (netIsGuest() && NET.phase === 'playing') netSendInput();
  if (netIsHost() && NET.phase === 'playing') netRecordActorHistory();
  if (!netIsHost() || NET.phase !== 'playing' || !netSocketOpen()) return;
  NET.snapshotAcc += dt;
  NET.checkpointAcc += dt;
  NET.eventAcc += dt;

  if (force || NET.snapshotAcc >= NET_SNAPSHOT_INTERVAL) {
    NET.snapshotAcc = force ? 0 : NET.snapshotAcc % NET_SNAPSHOT_INTERVAL;
    netSend({
      t: 'snapshot',
      v: NETP.VERSION,
      authorityEpoch: NET.authorityEpoch,
      round: NET.round,
      tick: G.tick,
      time: G.time,
      eventSeq: NET.eventSeq,
      manifestVersion: NET.manifestVersion,
      actors: G.actors.map(netPackActor),
      over: !!G.over,
      winner: G.winner ? netActorId(G.winner) : null
    }, !force);
  }

  if (force || NET.checkpointDirty || NET.checkpointAcc >= NET_CHECKPOINT_INTERVAL) {
    NET.checkpointAcc = force ? 0 : NET.checkpointAcc % NET_CHECKPOINT_INTERVAL;
    if (netSendCheckpoint()) NET.checkpointDirty = false;
  }

  /* Events used to leave only when a snapshot did, which put up to a whole
     snapshot interval between a guest's shot landing and its owner being told.
     They carry the hit feedback, so that wait was pure dead air on top of the
     round trip. Flushing them on their own clock spends a few more messages to
     get it back -- but not one per 60Hz tick: the relay closes a peer that
     exceeds 90 messages a second and snapshots already claim 20 of those. */
  if (force || NET.eventAcc >= NET_EVENT_INTERVAL) {
    NET.eventAcc = force ? 0 : NET.eventAcc % NET_EVENT_INTERVAL;
    netFlushEvents();
  }
}

/* How far behind the host's clock the guest renders everybody else.

   This used to be a flat two snapshot intervals -- 100ms at 20Hz, paid in full
   whether the connection needed it or not. It is not free: it is 100ms of
   extra reaction time handed to the host in every fight, on top of the
   latency, and lag compensation does nothing about it because the guest is
   still seeing the enemy late. The buffer only has to cover one interval plus
   however unevenly snapshots are actually arriving, so that is what it now
   costs. On a steady connection this is roughly 58ms instead of 100ms. */
function netInterpDelay() {
  return NETP.interpolationDelay(NET.snapshotInterval, NET.arrivalJitter);
}

function netGuestRenderTime(nowSeconds) {
  if (!NET.hostClockAt) return 0;
  const hostClock = NET.hostClock + Math.max(0, nowSeconds - NET.hostClockAt);
  return Math.max(0, hostClock - netInterpDelay());
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

/* Render-rate work only. Input used to be sent from here, gated to 33ms, which
   made it a sample of the player's intent taken on the display's clock rather
   than the simulation's. Two consequences, both paid by the guest: up to 33ms
   of dead time before anything was sent -- the residue that still loses a duel
   81/19 on a 5ms LAN, where the network is nearly free -- and an input stream
   the host consumed at a different rate than the guest predicted with, which
   makes an exact replay impossible. Sending is now netSendInput, once per
   simulation tick. */
function netFrame(now) {
  if (!netIsGuest() || NET.phase !== 'playing' || !G.player || !netSocketOpen()) return;
  NET.renderTime = netGuestRenderTime(now / 1000);
}

function netSendInput() {
  if (!netIsGuest() || NET.phase !== 'playing' || !G.player || !netSocketOpen()) return;
  const now = performance.now();
  const displayedRenderTime = NET.renderTime;
  const active = G.started && !G.paused && !G.over && G.player.alive;
  const p = G.player;
  const edgePending = IN.fireSeq > NET.lastFireSeqSent;
  const inputRenderTime = edgePending && Number.isFinite(IN.fireRenderTime)
    ? IN.fireRenderTime
    : displayedRenderTime;
  const seq = ++NET.inputSeq;
  /* Read through the same function the local simulation uses. These two used
     to read KEY/IN separately, so what the guest predicted and what it told
     the host it did were two hand-maintained transcriptions of one intent --
     and any drift between them showed up as the local player being corrected
     for input it thought it had sent. */
  const inp = readLocalInput(active);
  const message = {
    t: 'input',
    v: NETP.VERSION,
    authorityEpoch: NET.authorityEpoch,
    round: NET.round,
    seq: seq,
    fwd: inp.fwd,
    strafe: inp.strafe,
    jump: inp.jump,
    sprint: inp.sprint,
    fire: inp.fire,
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
  /* Stamp the step this tick predicted with the sequence that carried it, so
     reconciliation knows which steps the host has already accounted for. */
  for (let i = NET.pendingSteps.length - 1; i >= 0; i--) {
    if (NET.pendingSteps[i].seq !== null) break;
    NET.pendingSteps[i].seq = seq;
  }
}

/* One entry per simulated tick, holding the intent that tick was given. The
   struct is readLocalInput's, unchanged, so a replay feeds applyMovement
   exactly what the live step fed it. */
function netRecordPredictedStep(input, dt) {
  if (!netIsGuest() || NET.phase !== 'playing') return;
  NET.pendingSteps.push({
    seq: null,
    dt: dt,
    input: {
      fwd: input.fwd, strafe: input.strafe,
      jump: input.jump, sprint: input.sprint, fire: input.fire
    }
  });
  if (NET.pendingSteps.length > NET_MAX_PENDING_STEPS)
    NET.pendingSteps.splice(0, NET.pendingSteps.length - NET_MAX_PENDING_STEPS);
}

/* Reconciliation by replay.

   What this replaces damped the local player 16% of the way toward the
   authoritative state on every snapshot. That state describes where the guest
   was a full round trip ago, so the controller's fixed point is e = -v*RTT: it
   converges on cancelling the prediction outright, and the guest ends up
   rendered where the host thought it was ~190ms earlier. Correct velocity, so
   it does not feel slow -- it feels floaty, and releasing a key slides you
   about a metre past where you stopped.

   Replay instead: take the authoritative state, re-apply every input the host
   has not acknowledged yet, and land where those inputs actually put you. When
   prediction was right the result equals what was already on screen and
   nothing moves. Only genuine mispredictions produce a correction. */
function netReconcilePlayer(a, s) {
  const steps = NET.pendingSteps;
  let kept = 0;
  while (kept < steps.length && steps[kept].seq !== null && steps[kept].seq <= s.ack) kept++;
  if (kept > 0) steps.splice(0, kept);

  const shownX = a.pos.x, shownY = a.pos.y, shownZ = a.pos.z;

  a.pos.x = s.pos[0]; a.pos.y = s.pos[1]; a.pos.z = s.pos[2];
  a.vel.x = s.vel[0]; a.vel.y = s.vel[1]; a.vel.z = s.vel[2];
  a.onGround = !!s.onGround;

  for (const step of steps) applyMovement(a, step.input, step.dt);

  const residual = Math.hypot(a.pos.x - shownX, a.pos.y - shownY, a.pos.z - shownZ);
  /* A replay that lands somewhere far from the screen is a teleport -- a
     respawn, or a correction after a long stall -- not a misprediction to ease
     into. Take it as-is. Below that, ease the last of it out over a few frames
     so a small disagreement is not a visible flick; the offset is applied to
     the predicted result rather than to the authority, so it delays only the
     appearance of the correction and never the correction itself. */
  if (residual > 0.02 && residual <= NET_SNAP_DISTANCE) {
    a.pos.x = lerp(a.pos.x, shownX, NET_RESIDUAL_SMOOTHING);
    a.pos.y = lerp(a.pos.y, shownY, NET_RESIDUAL_SMOOTHING);
    a.pos.z = lerp(a.pos.z, shownZ, NET_RESIDUAL_SMOOTHING);
  }
  return residual;
}

function netFiniteIn(value, min, max) {
  return Number.isFinite(value) && value >= min && value <= max;
}

function netSafeCount(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000;
}

function netValidCheckpoint(message) {
  if (!message || typeof message !== 'object' || Array.isArray(message) ||
      message.t !== 'checkpoint' || message.v !== NETP.VERSION ||
      !Number.isSafeInteger(message.tick) || message.tick < 0 ||
      !netFiniteIn(message.time, 0, 100_000_000) ||
      !Number.isSafeInteger(message.manifestVersion) || message.manifestVersion < 1 ||
      !Array.isArray(message.actors) || message.actors.length < 1 ||
      message.actors.length > 16 ||
      !Array.isArray(message.events) || message.events.length > 128) return false;
  const ids = new Set();
  for (const actor of message.actors) {
    if (!actor || typeof actor !== 'object' || Array.isArray(actor) ||
        typeof actor.netId !== 'string' || !actor.netId || actor.netId.length > 80 ||
        ids.has(actor.netId) ||
        !['local', 'remote', 'bot'].includes(actor.controller) ||
        typeof actor.human !== 'boolean' ||
        (actor.human ? actor.controller === 'bot' : actor.controller !== 'bot') ||
        !['easy', 'normal', 'hard'].includes(actor.skill) ||
        !actor.ammoBy || typeof actor.ammoBy !== 'object' ||
        Array.isArray(actor.ammoBy)) return false;
    const weapons = Object.keys(actor.ammoBy);
    if (weapons.length > NETP.ALLOWED_WEAPONS.length ||
        weapons.some(weapon => !NETP.ALLOWED_WEAPONS.includes(weapon))) return false;
    for (const weapon of weapons) {
      const ammo = actor.ammoBy[weapon];
      if (!Array.isArray(ammo) || ammo.length !== 2 ||
          !netSafeCount(ammo[0]) || !netSafeCount(ammo[1])) return false;
    }
    ids.add(actor.netId);
  }
  return message.events.every(event => netValidEvent(event, ids));
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
    netSafeCount(s.streak) && netSafeCount(s.bestStreak) &&
    (s.lastHitBy === null ||
      (Number.isSafeInteger(s.lastHitBy) && s.lastHitBy > 0 &&
       s.lastHitBy <= 100_000)));
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
    NET.lastResidual = netReconcilePlayer(a, s);
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
      !Number.isSafeInteger(msg.eventSeq) || msg.eventSeq < 0 ||
      !Number.isSafeInteger(msg.manifestVersion) || msg.manifestVersion < 1 ||
      !Array.isArray(msg.actors) || msg.actors.length < 1 || msg.actors.length > 16) return;

  const seen = new Set();
  for (const state of msg.actors) {
    if (!netValidActorState(state) || seen.has(state.netId)) return;
    seen.add(state.netId);
  }
  if (!seen.has(NET.id)) return;
  if (NET.actorManifest) {
    if (msg.manifestVersion < NET.manifestVersion) return;
    if (msg.manifestVersion === NET.manifestVersion) {
      if (seen.size !== NET.actorManifest.size) return;
      for (const id of seen) if (!NET.actorManifest.has(id)) return;
    } else {
      NET.actorManifest = new Set(seen);
      NET.manifestVersion = msg.manifestVersion;
    }
  } else {
    NET.actorManifest = new Set(seen);
    NET.manifestVersion = msg.manifestVersion;
  }
  if (msg.over &&
      (typeof msg.winner !== 'string' || !NET.actorManifest.has(msg.winner))) return;

  NET.lastSnapshotTick = msg.tick;
  NET.lastRawSnapshot = msg;
  if (NET.lastSnapshotTime >= 0) {
    const interval = msg.time - NET.lastSnapshotTime;
    if (interval >= NET_SNAPSHOT_INTERVAL * 0.5 && interval <= NET_SNAPSHOT_INTERVAL * 4)
      NET.snapshotInterval = lerp(NET.snapshotInterval, interval, 0.2);
  }
  /* Sized off arrival, not off send: the host's cadence is regular by
     construction, and what the buffer has to absorb is the network making it
     irregular. Measured on the wall clock for that reason -- msg.time is the
     host's schedule and would report a steady stream however late it landed. */
  {
    const arrivedAt = performance.now() / 1000;
    if (NET.lastSnapshotAt > 0) {
      NET.arrivalJitter = NETP.trackArrivalJitter(
        NET.arrivalJitter, arrivedAt - NET.lastSnapshotAt, NET.snapshotInterval);
    }
    NET.lastSnapshotAt = arrivedAt;
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
    samples, NET.renderTime, netInterpDelay());
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
/* The shot sequence rides along so the guest that fired can tell which of its
   predicted hits this answers. Only a remote shooter's own shots are keyed;
   anything else sends null and is simply shown on arrival. */
function netShotSeq(fireSeq) {
  return Number.isSafeInteger(fireSeq) && fireSeq >= 0 ? fireSeq : null;
}
function netOnAuthoritativeShieldHit(target, from, x, y, z, fireSeq) {
  netSendEvent('shield', {
    target: netActorId(target), from: from ? netActorId(from) : null,
    at: [x, y, z], seq: netShotSeq(fireSeq)
  });
}
function netOnAuthoritativeDamage(target, from, damage, head, x, y, z, fireSeq) {
  netSendEvent('damage', {
    target: netActorId(target), from: from ? netActorId(from) : null,
    damage: netRound(damage), head: !!head, at: [x, y, z], seq: netShotSeq(fireSeq)
  });
}
/* Guest-side, display only. Nothing here touches health, kills or death --
   those stay the host's to decide and arrive by snapshot. All this buys is the
   round trip the player would otherwise spend staring at an unanswered shot. */
function netPredictHit(target, dmg, head, x, y, z, fireSeq) {
  if (!netIsGuest() || NET.phase !== 'playing' || !target) return;
  /* A shielded target answers with a `shield` event and no damage, so
     predicting a marker there would be a promise the host does not keep. The
     shield is replicated and ticks down locally, so this is usually right; when
     it is not, the shield event redeems the booking without showing anything. */
  if (target.shield > 0) return;
  if (!NETP.recordPredictedHit(NET.predictedHits, fireSeq, performance.now() / 1000)) return;
  SFX.hit(!!head);
  showHitmarker(!!head);
  addFloater(head ? Math.round(dmg) + '!' : String(Math.round(dmg)),
    x, y, z, head ? '#fff0a8' : '#ffffff', !!head);
}

/* True when the guest already showed this hit locally and the caller should
   stay quiet. Unpredicted hits -- a shot the guest scored without knowing, or
   any hit at all before this shipped -- still report normally. */
function netHitAlreadyShown(e) {
  return e.from === NET.id && e.seq !== null && e.seq !== undefined &&
    NETP.consumePredictedHit(NET.predictedHits, e.seq, performance.now() / 1000);
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
    authorityEpoch: NET.authorityEpoch,
    round: NET.round,
    winner: netActorId(winner)
  });
}

function netKnownActor(value, manifest) {
  const known = manifest || NET.actorManifest;
  return typeof value === 'string' && known && known.has(value);
}

function netEventPoint(value) {
  return Array.isArray(value) && value.length === 3 &&
    value.every(component => netFiniteIn(component, -200, 200));
}

/* Absent is as valid as null. `seq` is additive, and tolerating its absence is
   what keeps it from needing a protocol version of its own: a host that never
   sends it still produces events this guest accepts, at the cost of the
   deduplication only -- the feedback still arrives, it is just not matched to a
   prediction. See the note on netHitAlreadyShown for what that costs. */
function netValidShotSeq(value) {
  return value === null || value === undefined || netSafeCount(value);
}

function netValidEvent(e, manifest) {
  if (!e || typeof e !== 'object' || Array.isArray(e) ||
      !Number.isSafeInteger(e.id) || e.id < 1 ||
      typeof e.kind !== 'string') return false;
  if (e.kind === 'shot') {
    return netKnownActor(e.from, manifest) && !!WBY[e.weapon] &&
      Array.isArray(e.lines) && e.lines.length <= 16 &&
      e.lines.every(line => Array.isArray(line) && line.length === 6 &&
        line.every(component => netFiniteIn(component, -200, 200)));
  }
  if (e.kind === 'shield') {
    return netKnownActor(e.target, manifest) &&
      (e.from === null || netKnownActor(e.from, manifest)) && netEventPoint(e.at) &&
      netValidShotSeq(e.seq);
  }
  if (e.kind === 'damage') {
    return netKnownActor(e.target, manifest) &&
      (e.from === null || netKnownActor(e.from, manifest)) &&
      netFiniteIn(e.damage, 0, 500) && typeof e.head === 'boolean' &&
      netEventPoint(e.at) && netValidShotSeq(e.seq);
  }
  if (e.kind === 'kill') {
    return netKnownActor(e.target, manifest) &&
      (e.from === null || netKnownActor(e.from, manifest)) && netSafeCount(e.streak);
  }
  if (e.kind === 'respawn') {
    return netKnownActor(e.actor, manifest) && netEventPoint(e.at) &&
      Number.isSafeInteger(e.color) && e.color >= 0 && e.color <= 0xffffff;
  }
  return e.kind === 'match-over' && netKnownActor(e.winner, manifest);
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
    /* Redeem the booking even though nothing is drawn for it: the guest
       predicted a hit the host turned into a shield ping, and leaving the
       credit outstanding would let it swallow a later marker for this shot. */
    netHitAlreadyShown(e);
    if (target && Array.isArray(e.at)) fxShieldHit(target, e.at[0], e.at[1], e.at[2]);
  } else if (e.kind === 'damage') {
    if (e.from === NET.id && Array.isArray(e.at) && !netHitAlreadyShown(e)) {
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

  document.getElementById('quickPlay').addEventListener('click', () => {
    SFX.init(); SFX.resume(); SFX.ui();
    netQuickPlay();
  });
  document.getElementById('hostGame').addEventListener('click', () => netConnect('create'));
  document.getElementById('joinGame').addEventListener('click', () => netConnect('join', roomInput.value));

  const toggle = document.getElementById('roomToggle');
  const options = document.getElementById('roomOptions');
  if (toggle && options) {
    toggle.addEventListener('click', () => {
      const open = options.hidden;
      options.hidden = !open;
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    /* Someone who arrived on a link already cares about a specific room, so
       give them the code they came with rather than making them find it. */
    if (invited) {
      options.hidden = false;
      toggle.setAttribute('aria-expanded', 'true');
    }
  }

  const hold = document.getElementById('holdStart');
  if (hold) hold.addEventListener('click', () => { SFX.ui(); netCancelAutoStart(true); });

  const refresh = document.getElementById('refreshRooms');
  if (refresh) refresh.addEventListener('click', () => netRefreshRooms(true));
  netRefreshRooms(true);

  /* An invite link is an instruction, not a suggestion. Dial it — the callsign
     is either remembered or generated, and neither is worth a click. */
  if (invited) {
    netStatus('Joining ' + invited + '…');
    netConnect('join', invited);
  }
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
