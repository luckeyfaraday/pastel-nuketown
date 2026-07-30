import { randomInt, randomUUID } from 'node:crypto';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { WebSocket, WebSocketServer } from 'ws';
import Protocol from './net-protocol.js';

const ROOT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_INDEX_PATH = resolve(ROOT_DIR, 'index.html');
const DEFAULT_PROTOCOL_PATH = resolve(ROOT_DIR, 'net-protocol.js');

const RELAY_TYPES = new Set(['snapshot', 'checkpoint', 'event']);
const CHECKPOINT_CONTROLLERS = new Set(['local', 'remote', 'bot']);
const CHECKPOINT_SKILLS = new Set(['easy', 'normal', 'hard']);
const EVENT_KINDS = new Set(['shot', 'shield', 'damage', 'kill', 'respawn', 'match-over']);

function positiveInteger(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function secureRandom() {
  return randomInt(0, 0x100000000) / 0x100000000;
}

function memberList(room) {
  return Array.from(room.members.values(), (peer) => ({
    id: peer.id,
    name: peer.name,
    role: peer.role
  }));
}

export function createRelayServer(options = {}) {
  const indexPath = options.indexPath || DEFAULT_INDEX_PATH;
  const protocolPath = options.protocolPath || DEFAULT_PROTOCOL_PATH;
  const maxMessageBytes = positiveInteger(
    options.maxMessageBytes,
    Protocol.MAX_MESSAGE_BYTES
  );
  const ratePerSecond = positiveInteger(options.ratePerSecond, 90);
  const rateBurst = positiveInteger(options.rateBurst, 120);
  const heartbeatMs = options.heartbeatMs === 0
    ? 0
    : positiveInteger(options.heartbeatMs, 30_000);
  /* How long a guest may hold a seat in a running match without playing.
     Four seats and drop-in together make an idle body expensive: it is not
     just a body doing nothing, it is a body somebody else could be. Zero
     disables the sweep entirely. */
  const idleKickMs = options.idleKickMs === 0
    ? 0
    : positiveInteger(options.idleKickMs, 60_000);
  /* Fine enough that "a minute" means roughly a minute rather than up to two,
     cheap enough to be irrelevant: it walks a map of at most a few hundred. */
  const idleSweepMs = Math.max(50, Math.min(5_000, Math.floor(idleKickMs / 4) || 5_000));
  const backpressureBytes = positiveInteger(
    options.backpressureBytes,
    512 * 1024
  );
  const hardBackpressureBytes = positiveInteger(
    options.hardBackpressureBytes,
    2 * 1024 * 1024
  );
  const maxConnections = positiveInteger(options.maxConnections, 512);
  const maxRooms = positiveInteger(options.maxRooms, 128);
  const maxListedRooms = positiveInteger(options.maxListedRooms, Protocol.MAX_ROOM_LIST);
  /* WebSockets are exempt from the same-origin policy, so without this any
     page in the world can open a socket here and sit in the rooms. An empty
     allowlist keeps that wide-open behaviour, which is what local play,
     file:// pages and the tests rely on — set it in production. */
  const allowedOrigins = new Set(
    (Array.isArray(options.allowedOrigins) ? options.allowedOrigins : [])
      .map((origin) => String(origin).trim().replace(/\/+$/, '').toLowerCase())
      .filter(Boolean)
  );

  function originAllowed(request) {
    if (allowedOrigins.size === 0) return true;
    const origin = request.headers.origin;
    if (typeof origin !== 'string' || !origin) return false;
    return allowedOrigins.has(origin.trim().replace(/\/+$/, '').toLowerCase());
  }
  const joinTimeoutMs = positiveInteger(options.joinTimeoutMs, 15_000);
  const promotionTimeoutMs = positiveInteger(options.promotionTimeoutMs, 3_000);
  const snapshotStallCount = positiveInteger(options.snapshotStallCount, 24);
  /* That count prices the watchdog in observed snapshot intervals, which a
     fresh authority has not established yet -- and both `start` and a completed
     migration deliberately discard the previous host's cadence. This guards
     that gap: a flat deadline for an authority to prove it is simulating at
     all. Fifty snapshot intervals is far too long to be reached by a host that
     is merely slow, and short enough that walking a roomful of dead candidates
     costs seconds rather than the best part of a minute. */
  const authorityGraceMs = positiveInteger(options.authorityGraceMs, 2_500);
  /* How long a room with someone to play against waits before starting itself.
     This clock lives here rather than in the host's page because the case it
     exists for is a host who is not looking at their page: a backgrounded tab
     throttles its timers to a crawl and a locked phone stops them dead, so the
     one browser that could start the match is the one browser guaranteed not
     to. Short, because drop-in means a late arrival walks into the round
     already running rather than missing it. Zero disables the clock. */
  const autoStartMs = options.autoStartMs === 0
    ? 0
    : positiveInteger(options.autoStartMs, 5_000);
  /* HOLD buys a host keeping a seat for a friend more time; it cannot buy them
     silence. Every press pushes the deadline out by this much and no further,
     so a host who presses it and wanders off blocks the room for half a minute
     instead of forever. */
  const autoStartHoldMs = positiveInteger(options.autoStartHoldMs, 30_000);
  /* And how many times in a row. Without a cap, "press HOLD again" is a way to
     keep a room shut indefinitely — which is the behaviour this whole clock
     exists to take away, just with a script doing the waiting. */
  const autoStartMaxHolds = positiveInteger(options.autoStartMaxHolds, 2);
  /* Between rounds the same clock runs longer. A room in a lobby is people
     waiting to play; a room on a scoreboard is people reading one, and
     yanking that away five seconds after the winning shot is its own kind of
     nobody-asked-me. */
  const autoStartRematchMs = positiveInteger(options.autoStartRematchMs, 12_000);
  const makeId = typeof options.idFactory === 'function'
    ? options.idFactory
    : randomUUID;
  const roomRandom = typeof options.roomRandom === 'function'
    ? options.roomRandom
    : secureRandom;
  /* Where the lifetime match count lives across restarts. No path means no
     persistence: the count still runs, it just starts at zero each boot, which
     is what the tests and local play want. */
  const statsPath = typeof options.statsPath === 'string' && options.statsPath
    ? options.statsPath
    : null;
  const statsFlushMs = positiveInteger(options.statsFlushMs, 10_000);

  const rooms = new Map();
  const peers = new Map();

  /* Lifetime matches played, for the title screen. This counts entries into a
     room, not people: there are no accounts, so the only thing that could tell
     two players apart is their address, and keeping a record of every visitor's
     address to decorate a menu is a bad trade. One player who plays five rounds
     is five here, which is why the client says MATCHES and not PLAYERS. */
  let matchesPlayed = 0;
  let statsWritable = statsPath !== null;
  let statsTimer = null;
  let statsDirty = false;
  let statsWriteFailed = false;

  if (statsPath) {
    try {
      const saved = JSON.parse(readFileSync(statsPath, 'utf8'));
      const count = saved && saved.matches;
      if (!Number.isSafeInteger(count) || count < 0)
        throw new Error(`expected a non-negative integer, got ${JSON.stringify(count)}`);
      matchesPlayed = count;
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        /* First boot on a fresh host. Nothing to read, everything to write. */
      } else {
        /* The file exists but will not parse. Starting from zero *and* writing
           would overwrite a real history with a wrong number on the next flush,
           so stop writing and leave the file for a human. The relay keeps
           serving; a broken counter is not worth refusing to host games over. */
        statsWritable = false;
        console.error(
          `Refusing to write ${statsPath}: could not read the existing count (${error.message}). ` +
          'The lifetime match count will not be saved until this file is fixed or removed.'
        );
      }
    }
  }

  /* Temp file plus rename, so a crash midway through leaves the old count
     intact rather than a truncated file that reads as corrupt forever. */
  function flushStats() {
    if (!statsDirty || !statsWritable) return;
    const temp = `${statsPath}.${process.pid}.tmp`;
    try {
      writeFileSync(temp, `${JSON.stringify({ matches: matchesPlayed })}\n`);
      renameSync(temp, statsPath);
      statsDirty = false;
      statsWriteFailed = false;
    } catch (error) {
      /* Say it once. A read-only state directory would otherwise print this
         every flush for the life of the process. */
      if (!statsWriteFailed) {
        statsWriteFailed = true;
        console.error(`Unable to save the match count to ${statsPath}: ${error.message}`);
      }
    }
  }

  function countMatchPlayed() {
    matchesPlayed++;
    if (!statsWritable) return;
    statsDirty = true;
    /* Batched: a full room is four writes in a few seconds, and this number is
       decoration — losing the last few seconds of it to a hard kill is fine. */
    if (statsTimer) return;
    statsTimer = setTimeout(() => {
      statsTimer = null;
      flushStats();
    }, statsFlushMs);
    if (typeof statsTimer.unref === 'function') statsTimer.unref();
  }

  /* JSON.parse accepts extremely deep values. Walk iteratively so hostile
     payloads cannot turn a later String()/JSON.stringify() into stack
     exhaustion, and keep relay messages cheap enough to fan out safely. */
  function isSafeMessageShape(root) {
    const stack = [{ value: root, depth: 0 }];
    let nodes = 0;
    while (stack.length) {
      const { value, depth } = stack.pop();
      if (++nodes > 4096 || depth > 8) return false;
      if (value === null || typeof value === 'boolean' || typeof value === 'number') continue;
      if (typeof value === 'string') {
        if (value.length > 2048) return false;
        continue;
      }
      if (Array.isArray(value)) {
        if (value.length > 512) return false;
        for (const item of value) stack.push({ value: item, depth: depth + 1 });
        continue;
      }
      if (typeof value !== 'object') return false;
      const keys = Object.keys(value);
      if (keys.length > 64) return false;
      for (const key of keys) stack.push({ value: value[key], depth: depth + 1 });
    }
    return true;
  }

  function encode(message) {
    try { return JSON.stringify(message); }
    catch (error) { return null; }
  }

  function safeCount(value) {
    return Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000;
  }

  function validCheckpointEvent(event, actorIds) {
    if (!event || typeof event !== 'object' || Array.isArray(event) ||
        !Number.isSafeInteger(event.id) || event.id < 1 ||
        !EVENT_KINDS.has(event.kind)) return false;
    const known = (id) => typeof id === 'string' && actorIds.has(id);
    const point = (value) => Array.isArray(value) && value.length === 3 &&
      value.every((n) => Number.isFinite(n) && n >= -200 && n <= 200);
    const source = event.from === null || known(event.from);
    if (event.kind === 'shot') {
      return known(event.from) && Protocol.ALLOWED_WEAPONS.includes(event.weapon) &&
        Array.isArray(event.lines) && event.lines.length <= 16 &&
        event.lines.every((line) => Array.isArray(line) && line.length === 6 &&
          line.every((n) => Number.isFinite(n) && n >= -200 && n <= 200));
    }
    if (event.kind === 'shield')
      return known(event.target) && source && point(event.at) &&
        (event.seq == null || safeCount(event.seq));
    if (event.kind === 'damage')
      return known(event.target) && source && Number.isFinite(event.damage) &&
        event.damage >= 0 && event.damage <= 500 && typeof event.head === 'boolean' &&
        point(event.at) && (event.seq == null || safeCount(event.seq));
    if (event.kind === 'kill')
      return known(event.target) && source && safeCount(event.streak);
    if (event.kind === 'respawn')
      return known(event.actor) && point(event.at) &&
        Number.isSafeInteger(event.color) && event.color >= 0 && event.color <= 0xffffff;
    return known(event.winner);
  }

  function validCheckpoint(message) {
    if (!Number.isSafeInteger(message.tick) || message.tick < 0 ||
        !Number.isFinite(message.time) || message.time < 0 ||
        message.time > 100_000_000 ||
        !Number.isSafeInteger(message.manifestVersion) ||
        message.manifestVersion < 1 ||
        !Array.isArray(message.actors) || message.actors.length < 1 ||
        message.actors.length > 16 ||
        !Array.isArray(message.events) || message.events.length > 128) return false;

    const actorIds = new Set();
    for (const actor of message.actors) {
      if (!actor || typeof actor !== 'object' || Array.isArray(actor) ||
          typeof actor.netId !== 'string' || !actor.netId ||
          actor.netId.length > 80 || actorIds.has(actor.netId) ||
          !CHECKPOINT_CONTROLLERS.has(actor.controller) ||
          typeof actor.human !== 'boolean' ||
          (actor.human ? actor.controller === 'bot' : actor.controller !== 'bot') ||
          !CHECKPOINT_SKILLS.has(actor.skill) ||
          !actor.ammoBy || typeof actor.ammoBy !== 'object' ||
          Array.isArray(actor.ammoBy)) return false;
      const weapons = Object.keys(actor.ammoBy);
      if (weapons.length > Protocol.ALLOWED_WEAPONS.length ||
          weapons.some((weapon) => !Protocol.ALLOWED_WEAPONS.includes(weapon))) return false;
      for (const weapon of weapons) {
        const ammo = actor.ammoBy[weapon];
        if (!Array.isArray(ammo) || ammo.length !== 2 ||
            !safeCount(ammo[0]) || !safeCount(ammo[1])) return false;
      }
      actorIds.add(actor.netId);
    }
    return message.events.every((event) => validCheckpointEvent(event, actorIds));
  }

  /* Every room that opted in to listing, whether or not you can walk into it
     right now. Hiding running rooms made the browser read "no open rooms" at
     exactly the times the game had the most people in it, so a match in
     progress is advertised as unjoinable rather than left out — the population
     is the point, not just the vacancies.

     Joinable rooms are emitted first so a busy relay spends the list budget on
     seats you can take before it spends it on scenery. */
  function listedRooms() {
    const open = [];
    const running = [];

    for (const room of rooms.values()) {
      if (!room.listed || !room.host) continue;

      const summary = {
        code: room.code,
        host: room.host.name,
        players: room.members.size,
        max: Protocol.MAX_PLAYERS,
        inProgress: room.started
      };

      if (room.started) running.push(summary);
      else if (room.members.size < Protocol.MAX_PLAYERS) open.push(summary);
    }

    return open.concat(running).slice(0, maxListedRooms);
  }

  async function handleHttp(request, response) {
    let pathname;
    try {
      pathname = new URL(request.url || '/', 'http://localhost').pathname;
    } catch (error) {
      response.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('Bad request\n');
      return;
    }

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, {
        allow: 'GET, HEAD',
        'content-type': 'text/plain; charset=utf-8'
      });
      response.end('Method not allowed\n');
      return;
    }

    /* The room browser is public, read-only data, and the page is often
       opened straight off disk (file://), which makes this request
       cross-origin. Allow it explicitly and never cache it. */
    if (pathname === '/rooms') {
      /* Solo play never opens a socket, so this is the multiplayer population.
         Count only peers that finished the handshake and landed in a room —
         peers.size would also include the up-to-joinTimeoutMs window that
         scanners and abandoned tabs sit in, inflating the number. */
      let online = 0;
      for (const peer of peers.values()) if (peer.room) online++;
      const body = Buffer.from(
        JSON.stringify({ rooms: listedRooms(), online, matches: matchesPlayed }),
        'utf8'
      );
      /* Mirror the socket's policy: wide open when unconfigured, otherwise
         only the origins that are allowed to play here. */
      const origin = request.headers.origin;
      const shareWith = allowedOrigins.size === 0
        ? '*'
        : (originAllowed(request) ? origin : null);
      response.writeHead(200, {
        ...(shareWith ? { 'access-control-allow-origin': shareWith, vary: 'Origin' } : {}),
        'cache-control': 'no-store',
        'content-length': body.byteLength,
        'content-type': 'application/json; charset=utf-8',
        'x-content-type-options': 'nosniff'
      });
      response.end(request.method === 'HEAD' ? undefined : body);
      return;
    }

    let filePath;
    let contentType;
    if (pathname === '/' || pathname === '/index.html') {
      filePath = indexPath;
      contentType = 'text/html; charset=utf-8';
    } else if (pathname === '/net-protocol.js') {
      filePath = protocolPath;
      contentType = 'text/javascript; charset=utf-8';
    } else {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('Not found\n');
      return;
    }

    try {
      const body = await readFile(filePath);
      response.writeHead(200, {
        'cache-control': 'no-cache',
        'content-length': body.byteLength,
        'content-type': contentType,
        'x-content-type-options': 'nosniff'
      });
      response.end(request.method === 'HEAD' ? undefined : body);
    } catch (error) {
      response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('Unable to load game\n');
    }
  }

  const server = createHttpServer((request, response) => {
    handleHttp(request, response).catch(() => {
      if (!response.headersSent) {
        response.writeHead(500, {
          'content-type': 'text/plain; charset=utf-8'
        });
      }
      response.end('Internal server error\n');
    });
  });

  const wss = new WebSocketServer({
    clientTracking: false,
    maxPayload: maxMessageBytes,
    noServer: true,
    perMessageDeflate: false
  });

  function sendEncoded(peer, encoded, isSnapshot = false) {
    if (!peer || encoded === null || peer.ws.readyState !== WebSocket.OPEN) return false;
    if (peer.ws.bufferedAmount > hardBackpressureBytes) {
      peer.ws.terminate();
      return false;
    }
    if (isSnapshot && peer.ws.bufferedAmount > backpressureBytes) return false;

    try {
      peer.ws.send(encoded);
      return true;
    } catch (error) {
      return false;
    }
  }

  function send(peer, message, isSnapshot = false) {
    return sendEncoded(peer, encode(message), isSnapshot);
  }

  function sendError(peer, code, message) {
    send(peer, {
      t: 'error',
      v: Protocol.VERSION,
      code,
      message
    });
  }

  function broadcastMembers(room) {
    const encoded = encode({
      t: 'members',
      v: Protocol.VERSION,
      members: memberList(room),
      autoStartIn: autoStartRemaining(room)
    });

    for (const peer of room.members.values()) {
      sendEncoded(peer, encoded);
    }
  }

  /* ---- automatic start ---------------------------------------------------

     A lobby waits on a clock rather than on a person. The clock is here and
     not in the host's page because the host who needs it most is the one who
     stopped looking at their page, and a browser that is not being looked at
     is a browser whose timers have been throttled to a crawl or stopped
     outright. Every room therefore starts itself, and START MATCH is left for
     the impatient. */

  function autoStartEligible(room) {
    return autoStartMs > 0 && !room.started && !room.migrating &&
      !!room.host && room.members.size >= 2;
  }

  function clearAutoStart(room) {
    if (room.autoStartTimer) clearTimeout(room.autoStartTimer);
    room.autoStartTimer = null;
    room.autoStartAt = 0;
    /* Holds are spent per wait, not per room: every fresh clock — a new round,
       a rebuilt roster — is a fresh case for keeping a seat open. */
    room.autoStartHolds = 0;
  }

  /* The deadline outlives the timer that watches it, so a roster change re-arms
     without moving the moment: the number already counting down on four screens
     must not jump back up because a fifth person opened the door. */
  function scheduleAutoStart(room) {
    if (!autoStartEligible(room)) {
      clearAutoStart(room);
      return;
    }
    if (!room.autoStartAt) {
      room.autoStartAt = Date.now() +
        (room.round > 0 ? autoStartRematchMs : autoStartMs);
    }
    if (room.autoStartTimer) clearTimeout(room.autoStartTimer);
    room.autoStartTimer = setTimeout(() => {
      room.autoStartTimer = null;
      if (!autoStartEligible(room)) return;
      /* Nothing here asks the host first, and nothing waits for it to answer.
         If its page is asleep the round begins without it and the snapshot
         watchdog hands authority to somebody awake a couple of seconds later,
         which is a match starting late rather than a room never starting. */
      startRound(room);
    }, Math.max(0, room.autoStartAt - Date.now()));
    if (typeof room.autoStartTimer.unref === 'function') room.autoStartTimer.unref();
  }

  /* Milliseconds left, or null for a room that is not counting. Sent with the
     roster so every client — guests included — can show the same clock instead
     of watching a roster that never moves and hoping. */
  function autoStartRemaining(room) {
    if (!room.autoStartTimer || !room.autoStartAt) return null;
    return Math.max(0, room.autoStartAt - Date.now());
  }

  function startRound(room) {
    clearAutoStart(room);
    room.started = true;
    room.round++;
    room.latestSnapshot = null;
    room.latestCheckpoint = null;
    room.snapshotAt = 0;
    room.snapshotIntervalMs = 0;
    armSnapshotStall(room, room.host, authorityGraceMs);
    /* A round starting is a fresh slate for everyone: time spent waiting in
       the lobby is not time spent away from a match. */
    for (const member of room.members.values()) {
      member.lastSeq = -1;
      member.activeAt = Date.now();
    }
    broadcastRoom(room, {
      t: 'start',
      v: Protocol.VERSION,
      authorityEpoch: room.authorityEpoch,
      round: room.round,
      members: memberList(room)
    }, true);
  }

  function broadcastRoom(room, message, includeHost = false) {
    const encoded = encode(message);
    if (encoded === null) return false;
    const isSnapshot = message.t === 'snapshot';

    for (const peer of room.members.values()) {
      if (includeHost || peer.role === 'guest') sendEncoded(peer, encoded, isSnapshot);
    }
    return true;
  }

  function consumeRateToken(peer) {
    const now = Date.now();
    const elapsedSeconds = Math.max(0, now - peer.rateUpdatedAt) / 1000;
    peer.rateUpdatedAt = now;
    peer.rateTokens = Math.min(
      rateBurst,
      peer.rateTokens + elapsedSeconds * ratePerSecond
    );

    if (peer.rateTokens < 1) return false;
    peer.rateTokens -= 1;
    return true;
  }

  function reserveRoomCode() {
    for (let attempt = 0; attempt < 128; attempt++) {
      const code = Protocol.createRoomCode(roomRandom);
      if (!rooms.has(code)) return code;
    }
    return null;
  }

  function enterRoom(peer, room, role, name) {
    if (peer.joinTimer) clearTimeout(peer.joinTimer);
    peer.joinTimer = null;
    peer.name = name;
    peer.role = role;
    peer.room = room;
    peer.lastSeq = -1;
    /* Arriving is activity. A drop-in gets the full grace period to find the
       deploy card, and nobody is judged on time spent before they were here. */
    peer.activeAt = Date.now();
    room.members.set(peer.id, peer);
    if (role === 'host') room.host = peer;
    /* Here rather than at connect: this is the point a peer has cleared the
       handshake and taken a seat, so scanners and abandoned tabs never land in
       the total. Host migration reuses the peers already counted — it does not
       come back through here. */
    countMatchPlayed();
  }

  /* The round is part of the handshake, not just of `start`. A player who
     joins a room that has already run a round starts from that room's round,
     so the next `start` they see is the expected step forward. Without this a
     late joiner sits in the lobby ignoring every start it is sent.

     `started` is the same idea one step further: it tells a peer arriving
     mid-round to walk into the match rather than wait in a lobby for a start
     that already happened. The relay sends no world state with it — the host
     seats the arrival on the next roster broadcast and the existing snapshot
     stream carries the world, which is why drop-in needs no new message. */
  function roomReply(peer) {
    send(peer, {
      t: 'room',
      v: Protocol.VERSION,
      room: peer.room.code,
      id: peer.id,
      role: peer.role,
      authorityEpoch: peer.room.authorityEpoch,
      round: peer.room.round,
      started: peer.room.started,
      members: memberList(peer.room),
      autoStartIn: autoStartRemaining(peer.room)
    });
  }

  function handleCreate(peer, message) {
    const name = Protocol.cleanPlayerName(message.name);
    if (!name) {
      sendError(peer, 'invalid-name', 'Choose a player name.');
      return;
    }
    if (rooms.size >= maxRooms) {
      sendError(peer, 'server-full', 'The room server is full.');
      return;
    }

    const code = reserveRoomCode();
    if (!code) {
      sendError(peer, 'room-code-exhausted', 'Unable to create a room.');
      return;
    }

    const room = {
      code,
      host: null,
      members: new Map(),
      started: false,
      round: 0,
      authorityEpoch: 1,
      latestSnapshot: null,
      latestCheckpoint: null,
      migrating: null,
      snapshotAt: 0,
      snapshotIntervalMs: 0,
      snapshotStallTimer: null,
      autoStartTimer: null,
      autoStartAt: 0,
      autoStartHolds: 0,
      /* Listed by default so the room browser is useful out of the box;
         a host that wants the old code-only privacy sends listed:false. */
      listed: message.listed !== false
    };
    rooms.set(code, room);
    enterRoom(peer, room, 'host', name);
    roomReply(peer);
    broadcastMembers(room);
  }

  function handleJoin(peer, message) {
    const name = Protocol.cleanPlayerName(message.name);
    if (!name) {
      sendError(peer, 'invalid-name', 'Choose a player name.');
      return;
    }

    const code = Protocol.normalizeRoomCode(message.room);
    const room = rooms.get(code);
    if (!room) {
      sendError(peer, 'room-not-found', 'That room does not exist.');
      return;
    }
    /* A started room is joinable now. The one state that is not is a room
       changing host: the migration is waiting on state from a known set of
       guests, and a peer that was not in that set when it began has nothing
       to contribute and no world to be handed. It resolves in well under a
       second, so this is "try again", not "go away". */
    if (room.migrating) {
      sendError(peer, 'room-migrating', 'That room is changing host. Try again in a moment.');
      return;
    }
    if (room.members.size >= Protocol.MAX_PLAYERS) {
      sendError(peer, 'room-full', 'That room is full.');
      return;
    }

    enterRoom(peer, room, 'guest', name);
    /* Before either reply: the arrival is the second body that starts the
       clock, and both messages are meant to carry the clock's answer. */
    scheduleAutoStart(room);
    roomReply(peer);
    broadcastMembers(room);
  }

  /* Shortest turn between two angles, so a yaw that wrapped past PI reads as
     the small movement it was rather than a full lap. */
  function angleGap(a, b) {
    let gap = (a - b) % (Math.PI * 2);
    if (gap > Math.PI) gap -= Math.PI * 2;
    if (gap < -Math.PI) gap += Math.PI * 2;
    return Math.abs(gap);
  }

  /* Away-from-keyboard is a question about the player, not the socket: an idle
     client still sends input sixty times a second, it is just the same input
     every time. So the test is what the input says, not that it arrived.

     Looking around counts. Someone turning to watch a firefight is present,
     and the epsilon is only there to ignore the last hair of the client's own
     aim damping settling to a stop. */
  const AIM_EPSILON = 0.005;
  function inputShowsAPlayer(peer, input) {
    if (input.fwd !== 0 || input.strafe !== 0 || input.jump || input.fire) return true;
    if (input.fireSeq !== peer.lastFireSeq ||
        input.weaponSeq !== peer.lastWeaponSeq ||
        input.reloadSeq !== peer.lastReloadSeq) return true;
    return angleGap(input.yaw, peer.lastYaw) > AIM_EPSILON ||
      Math.abs(input.pitch - peer.lastPitch) > AIM_EPSILON;
  }

  function handleGuestInput(peer, message) {
    if (!peer.room.started || peer.room.migrating ||
        message.round !== peer.room.round ||
        message.authorityEpoch !== peer.room.authorityEpoch) return;
    const sanitized = Protocol.sanitizeInput(message, peer.lastSeq);
    if (!sanitized.ok) {
      sendError(peer, 'invalid-input', sanitized.error);
      return;
    }

    if (idleKickMs > 0 && inputShowsAPlayer(peer, sanitized.value))
      peer.activeAt = Date.now();
    peer.lastFireSeq = sanitized.value.fireSeq;
    peer.lastWeaponSeq = sanitized.value.weaponSeq;
    peer.lastReloadSeq = sanitized.value.reloadSeq;
    peer.lastYaw = sanitized.value.yaw;
    peer.lastPitch = sanitized.value.pitch;

    peer.lastSeq = sanitized.value.seq;
    send(peer.room.host, {
      ...sanitized.value,
      from: peer.id
    });
  }

  function hasCurrentAuthority(peer, message) {
    if (message.authorityEpoch === peer.room.authorityEpoch) return true;
    sendError(peer, 'stale-authority', 'That authority epoch is no longer active.');
    return false;
  }

  function handleRoomMessage(peer, message) {
    if (message.t === 'create' || message.t === 'join') {
      sendError(peer, 'already-in-room', 'Leave this room before joining another.');
      return;
    }

    if (message.t === 'authority-state') {
      const migration = peer.room.migrating;
      if (peer.role !== 'guest' || !migration ||
          message.authorityEpoch !== peer.room.authorityEpoch ||
          message.round !== peer.room.round) return;
      const checked = Protocol.sanitizeAuthorityState(message);
      if (!checked.ok) {
        sendError(peer, 'invalid-authority-state', checked.error);
        return;
      }
      migration.states.set(peer.id, checked.value);
      send(peer.room.host, { ...checked.value, from: peer.id });
      return;
    }

    if (message.t === 'authority-ready') {
      const migration = peer.room.migrating;
      if (peer.role !== 'host' || !migration ||
          message.authorityEpoch !== peer.room.authorityEpoch ||
          message.round !== peer.room.round ||
          !Number.isSafeInteger(message.tick) ||
          message.tick !== migration.snapshot.tick) return;
      for (const id of migration.expected) {
        if (!migration.states.has(id)) {
          sendError(peer, 'authority-not-ready', 'Waiting for surviving guest state.');
          return;
        }
      }
      finishMigration(peer.room);
      return;
    }

    if (message.t === 'input') {
      if (peer.role !== 'guest') {
        sendError(peer, 'guest-only', 'Only guests send input to the host.');
        return;
      }
      handleGuestInput(peer, message);
      return;
    }

    if (message.t === 'start') {
      if (peer.role !== 'host') {
        sendError(peer, 'host-only', 'Only the host can start a match.');
        return;
      }
      if (!hasCurrentAuthority(peer, message)) return;
      if (peer.room.started) {
        sendError(peer, 'already-started', 'The match is already running.');
        return;
      }
      startRound(peer.room);
      return;
    }

    /* HOLD: the host is keeping a seat for somebody. It buys time and nothing
       else — the deadline moves, it never goes away — so the room stays a room
       people can join and leave rather than one person's waiting decision. */
    if (message.t === 'hold') {
      if (peer.role !== 'host') {
        sendError(peer, 'host-only', 'Only the host can hold the start.');
        return;
      }
      if (!hasCurrentAuthority(peer, message)) return;
      if (!autoStartEligible(peer.room)) return;
      if (peer.room.autoStartHolds >= autoStartMaxHolds) {
        sendError(peer, 'hold-exhausted',
          'The start cannot be held any longer — everyone here is waiting to play.');
        return;
      }
      peer.room.autoStartHolds++;
      peer.room.autoStartAt = Date.now() + autoStartHoldMs;
      scheduleAutoStart(peer.room);
      broadcastMembers(peer.room);
      return;
    }

    if (message.t === 'lobby') {
      if (peer.role !== 'host') {
        sendError(peer, 'host-only', 'Only the host can end a round.');
        return;
      }
      if (!hasCurrentAuthority(peer, message)) return;
      if (!peer.room.started || message.round !== peer.room.round) return;
      peer.room.started = false;
      clearSnapshotStall(peer.room);
      peer.room.snapshotAt = 0;
      peer.room.snapshotIntervalMs = 0;
      /* Back between rounds is back on the clock: a rematch nobody calls for
         strands a room exactly the way an uncalled first round does. */
      scheduleAutoStart(peer.room);
      broadcastRoom(peer.room, {
        t: 'lobby',
        v: Protocol.VERSION,
        authorityEpoch: peer.room.authorityEpoch,
        round: peer.room.round,
        winner: typeof message.winner === 'string' ? message.winner.slice(0, 80) : null
      });
      /* After, not before. The roster is what carries the deadline, and a
         client only knows where to show it once the message above has told it
         the round is over. */
      broadcastMembers(peer.room);
      return;
    }

    if (RELAY_TYPES.has(message.t)) {
      if (peer.role !== 'host') {
        sendError(peer, 'host-only', 'Only the host can send match state.');
        return;
      }
      if (!hasCurrentAuthority(peer, message)) return;
      if (peer.room.migrating) return;
      if (!peer.room.started || message.round !== peer.room.round) return;
      if (message.t === 'snapshot' &&
          (!Number.isSafeInteger(message.tick) || !Number.isFinite(message.time) ||
           !Number.isSafeInteger(message.eventSeq) ||
           !Number.isSafeInteger(message.manifestVersion) ||
           !Array.isArray(message.actors) ||
           message.actors.length > 16)) {
        sendError(peer, 'invalid-snapshot', 'Invalid snapshot.');
        return;
      }
      if (message.t === 'checkpoint' && !validCheckpoint(message)) {
        sendError(peer, 'invalid-checkpoint', 'Invalid checkpoint.');
        return;
      }
      if (message.t === 'event' &&
          (!Array.isArray(message.events) || message.events.length > 256)) {
        sendError(peer, 'invalid-event', 'Invalid event batch.');
        return;
      }
      if (message.t === 'snapshot') {
        if (peer.room.latestSnapshot &&
            message.tick < peer.room.latestSnapshot.tick) return;
        peer.room.latestSnapshot = message;
        observeSnapshot(peer.room, peer);
      } else if (message.t === 'checkpoint') {
        if (peer.room.latestCheckpoint &&
            message.tick < peer.room.latestCheckpoint.tick) return;
        peer.room.latestCheckpoint = message;
      }
      broadcastRoom(peer.room, message);
      return;
    }

    sendError(peer, 'unknown-type', 'Unknown message type.');
  }

  function handleMessage(peer, raw) {
    if (!consumeRateToken(peer)) {
      sendError(peer, 'rate-limit', 'Too many messages.');
      peer.ws.close(1008, 'rate limit exceeded');
      return;
    }

    const parsed = Protocol.parseWireMessage(raw, maxMessageBytes);
    if (!parsed.ok) {
      sendError(peer, 'invalid-message', parsed.error);
      return;
    }

    const message = parsed.value;
    if (!isSafeMessageShape(message)) {
      sendError(peer, 'invalid-shape', 'Message nesting or collection size is invalid.');
      return;
    }
    if (message.v !== Protocol.VERSION) {
      /* The client renders this string verbatim, and the only person who ever
         sees it is a player holding a page from before the last deploy. Naming
         the protocol tells them nothing they can act on; "reload" is the whole
         remedy, so say that instead. */
      sendError(peer, 'version', 'This game is out of date. Reload the page to keep playing.');
      return;
    }

    if (!peer.room) {
      if (message.t === 'create') {
        handleCreate(peer, message);
      } else if (message.t === 'join') {
        handleJoin(peer, message);
      } else {
        sendError(peer, 'not-in-room', 'Create or join a room first.');
      }
      return;
    }

    handleRoomMessage(peer, message);
  }

  function clearRoomMembership(peer) {
    peer.room = null;
    peer.role = null;
    peer.name = '';
    peer.lastSeq = -1;
  }

  function clearSnapshotStall(room) {
    if (room.snapshotStallTimer) clearTimeout(room.snapshotStallTimer);
    room.snapshotStallTimer = null;
  }

  function armSnapshotStall(room, host, delayMs) {
    clearSnapshotStall(room);
    if (!room.started || room.migrating || !host) return;
    const epoch = room.authorityEpoch;
    room.snapshotStallTimer = setTimeout(() => {
      room.snapshotStallTimer = null;
      if (room.started && !room.migrating && room.host === host &&
          room.authorityEpoch === epoch) {
        beginMigration(room, host, true);
        try { host.ws.close(1012, 'authority snapshot stalled'); } catch (error) {}
      }
    }, delayMs);
    if (typeof room.snapshotStallTimer.unref === 'function')
      room.snapshotStallTimer.unref();
  }

  function observeSnapshot(room, host) {
    const now = Date.now();
    if (room.snapshotAt) {
      const sample = now - room.snapshotAt;
      if (sample >= 10 && sample <= 5_000) {
        room.snapshotIntervalMs = room.snapshotIntervalMs
          ? room.snapshotIntervalMs * 0.8 + sample * 0.2
          : sample;
      }
    }
    room.snapshotAt = now;
    /* Until a second snapshot has priced the cadence, the grace deadline stands
       in for it. Giving up here instead left the room with no watchdog at all,
       which a host that sent exactly one snapshot -- the forced one every
       migration ends with -- turned into a room nothing was ever watching. */
    armSnapshotStall(room, host, room.snapshotIntervalMs
      ? Math.ceil(room.snapshotIntervalMs * snapshotStallCount)
      : authorityGraceMs);
  }

  function canMigrateSeamlessly(room) {
    const snapshot = room.latestSnapshot;
    const checkpoint = room.latestCheckpoint;
    if (!snapshot || !checkpoint ||
        snapshot.authorityEpoch !== room.authorityEpoch ||
        checkpoint.authorityEpoch !== room.authorityEpoch ||
        snapshot.round !== room.round || checkpoint.round !== room.round ||
        !Array.isArray(snapshot.actors) || snapshot.actors.length < 1 ||
        snapshot.over !== false ||
        snapshot.manifestVersion !== checkpoint.manifestVersion) return false;
    const migrationBytes = encode({ snapshot, checkpoint });
    if (migrationBytes === null ||
        Buffer.byteLength(migrationBytes, 'utf8') > maxMessageBytes - 4096) return false;
    const metadata = new Set(checkpoint.actors.map((actor) => actor.netId));
    return metadata.size === snapshot.actors.length &&
      snapshot.actors.every((actor) =>
      actor && typeof actor.netId === 'string' && metadata.has(actor.netId));
  }

  function nextMigrationCandidate(room) {
    const attempted = room.migrating ? room.migrating.attempted : new Set();
    for (const peer of room.members.values()) {
      if (peer.role === 'guest' && peer.alive && !attempted.has(peer.id)) return peer;
    }
    return null;
  }

  function fallbackRestart(room) {
    if (room.migrating && room.migrating.timer) clearTimeout(room.migrating.timer);
    room.migrating = null;
    clearSnapshotStall(room);
    const nextHost = room.members.values().next().value;
    if (!nextHost) {
      clearAutoStart(room);
      rooms.delete(room.code);
      room.host = null;
      room.started = false;
      return;
    }
    for (const member of room.members.values())
      member.role = member === nextHost ? 'host' : 'guest';
    room.host = nextHost;
    room.started = false;
    room.round++;
    room.authorityEpoch++;
    room.latestSnapshot = null;
    room.latestCheckpoint = null;
    for (const member of room.members.values()) {
      member.lastSeq = -1;
      member.activeAt = Date.now();
    }
    /* The new host inherits a lobby, so it inherits the clock too — and the
       roster broadcast is what carries the deadline, since `host-changed` is a
       fixed shape the clients sanitise field by field. */
    scheduleAutoStart(room);
    broadcastRoom(room, {
      t: 'host-changed',
      v: Protocol.VERSION,
      authorityEpoch: room.authorityEpoch,
      round: room.round,
      host: nextHost.id,
      members: memberList(room)
    }, true);
    broadcastMembers(room);
  }

  function attemptPromotion(room) {
    const nextHost = nextMigrationCandidate(room);
    if (!nextHost) {
      fallbackRestart(room);
      return;
    }
    if (room.migrating.timer) clearTimeout(room.migrating.timer);
    for (const member of room.members.values())
      member.role = member === nextHost ? 'host' : 'guest';
    room.migrating.attempted.add(nextHost.id);
    room.migrating.states = new Map();
    room.migrating.expected = new Set(
      Array.from(room.members.values(), (peer) => peer.id)
        .filter((id) => id !== nextHost.id)
    );
    room.host = nextHost;
    room.authorityEpoch++;
    broadcastRoom(room, {
      t: 'host-changed',
      v: Protocol.VERSION,
      authorityEpoch: room.authorityEpoch,
      round: room.round,
      host: nextHost.id,
      members: memberList(room),
      seamless: true,
      snapshot: room.migrating.snapshot,
      checkpoint: room.migrating.checkpoint
    }, true);
    room.migrating.timer = setTimeout(() => {
      if (!room.migrating || room.host !== nextHost) return;
      nextHost.role = 'guest';
      attemptPromotion(room);
    }, promotionTimeoutMs);
    if (typeof room.migrating.timer.unref === 'function')
      room.migrating.timer.unref();
  }

  function beginMigration(room, failedHost, removeHost) {
    clearSnapshotStall(room);
    clearAutoStart(room);
    if (removeHost) {
      room.members.delete(failedHost.id);
      clearRoomMembership(failedHost);
    } else {
      failedHost.role = 'guest';
    }
    if (!room.members.size) {
      rooms.delete(room.code);
      room.host = null;
      room.started = false;
      return;
    }
    if (!room.started || !canMigrateSeamlessly(room)) {
      /* fallbackRestart puts the room back in a lobby, which is a lobby that
         needs its clock re-armed — it does that itself. */
      fallbackRestart(room);
      return;
    }
    room.migrating = {
      attempted: new Set([failedHost.id]),
      states: new Map(),
      expected: new Set(),
      snapshot: room.latestSnapshot,
      checkpoint: room.latestCheckpoint,
      timer: null
    };
    attemptPromotion(room);
  }

  function finishMigration(room) {
    if (!room.migrating) return;
    if (room.migrating.timer) clearTimeout(room.migrating.timer);
    room.migrating = null;
    for (const member of room.members.values()) {
      member.lastSeq = -1;
      member.activeAt = Date.now();
    }
    broadcastRoom(room, {
      t: 'authority-ready',
      v: Protocol.VERSION,
      authorityEpoch: room.authorityEpoch,
      round: room.round,
      host: room.host.id
    }, true);
    room.snapshotAt = 0;
    room.snapshotIntervalMs = 0;
    armSnapshotStall(room, room.host, authorityGraceMs);
  }

  function migrateHostedRoom(room, departedHost) {
    if (room.migrating) {
      room.members.delete(departedHost.id);
      clearRoomMembership(departedHost);
      attemptPromotion(room);
      return;
    }
    beginMigration(room, departedHost, true);
  }

  function leaveRoom(peer) {
    const room = peer.room;
    if (!room) return;

    if (peer.role === 'host') {
      migrateHostedRoom(room, peer);
      return;
    }

    room.members.delete(peer.id);
    clearRoomMembership(peer);
    if (room.migrating) room.migrating.expected.delete(peer.id);
    /* A room back down to one person has nobody to play against, so the clock
       stops rather than starting a host alone against the bots. */
    scheduleAutoStart(room);
    broadcastMembers(room);
  }

  function cleanupPeer(peer) {
    if (peer.cleanedUp) return;
    peer.cleanedUp = true;
    if (peer.joinTimer) clearTimeout(peer.joinTimer);
    peers.delete(peer.ws);
    leaveRoom(peer);
  }

  wss.on('connection', (ws) => {
    const peer = {
      ws,
      id: String(makeId()),
      name: '',
      role: null,
      room: null,
      lastSeq: -1,
      alive: true,
      cleanedUp: false,
      rateTokens: rateBurst,
      rateUpdatedAt: Date.now(),
      joinTimer: null,
      activeAt: Date.now(),
      lastFireSeq: -1,
      lastWeaponSeq: -1,
      lastReloadSeq: -1,
      lastYaw: 0,
      lastPitch: 0
    };
    peers.set(ws, peer);
    peer.joinTimer = setTimeout(() => {
      if (!peer.room && peer.ws.readyState === WebSocket.OPEN)
        peer.ws.close(1008, 'room handshake timeout');
    }, joinTimeoutMs);
    if (typeof peer.joinTimer.unref === 'function') peer.joinTimer.unref();

    ws.on('pong', () => {
      peer.alive = true;
    });
    ws.on('message', (raw) => {
      try {
        handleMessage(peer, raw);
      } catch (error) {
        sendError(peer, 'invalid-message', 'Message processing failed.');
        peer.ws.close(1008, 'invalid message');
      }
    });
    ws.on('close', () => {
      cleanupPeer(peer);
    });
    ws.on('error', () => {
      cleanupPeer(peer);
    });
  });

  server.on('upgrade', (request, socket, head) => {
    let pathname;
    try {
      pathname = new URL(request.url || '/', 'http://localhost').pathname;
    } catch (error) {
      socket.destroy();
      return;
    }

    if (pathname !== '/ws') {
      socket.destroy();
      return;
    }
    if (!originAllowed(request)) {
      socket.destroy();
      return;
    }
    if (peers.size >= maxConnections) {
      socket.destroy();
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  });

  /* Only guests, and only in a running match. The host is the simulation —
     dropping it costs everybody a migration to reclaim one seat — and a lobby
     is a place where sitting still is the entire activity. */
  function sweepIdlePeers() {
    const now = Date.now();
    for (const peer of peers.values()) {
      if (peer.role !== 'guest' || !peer.room || !peer.room.started) continue;
      if (peer.room.migrating) continue;
      if (now - peer.activeAt < idleKickMs) continue;
      sendError(peer, 'idle', 'Removed for sitting out the match.');
      try { peer.ws.close(1008, 'idle'); } catch (error) { peer.ws.terminate(); }
    }
  }

  const idleSweep = idleKickMs > 0 ? setInterval(sweepIdlePeers, idleSweepMs) : null;
  if (idleSweep && typeof idleSweep.unref === 'function') idleSweep.unref();

  const heartbeat = heartbeatMs > 0
    ? setInterval(() => {
      for (const peer of peers.values()) {
        if (!peer.alive) {
          peer.ws.terminate();
          continue;
        }

        peer.alive = false;
        try {
          peer.ws.ping();
        } catch (error) {
          peer.ws.terminate();
        }
      }
    }, heartbeatMs)
    : null;
  if (heartbeat && typeof heartbeat.unref === 'function') heartbeat.unref();

  async function close() {
    if (heartbeat) clearInterval(heartbeat);
    if (idleSweep) clearInterval(idleSweep);
    /* A planned shutdown is a deploy, and a deploy that quietly dropped the
       last few minutes of the count would be the common case, not the rare one. */
    if (statsTimer) clearTimeout(statsTimer);
    statsTimer = null;
    flushStats();
    for (const room of rooms.values()) {
      clearSnapshotStall(room);
      clearAutoStart(room);
      if (room.migrating && room.migrating.timer) clearTimeout(room.migrating.timer);
    }
    for (const peer of peers.values()) peer.ws.terminate();

    if (!server.listening) return;
    await new Promise((resolveClose, rejectClose) => {
      server.close((error) => {
        if (error) rejectClose(error);
        else resolveClose();
      });
    });
  }

  return {
    server,
    wss,
    rooms,
    listen: (...args) => server.listen(...args),
    address: () => server.address(),
    close
  };
}

const isMain = process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

/* systemd sets STATE_DIRECTORY from `StateDirectory=` in the unit, and that is
   the only path the service can write to — ProtectSystem=strict makes the
   install directory read-only. Taking the path from the environment rather
   than hardcoding /var/lib/nuketown keeps the two in step, and running without
   it (a bare `npm start`) simply means the count does not persist. Colons
   separate multiple directories; the first is ours. */
function statsPathFromEnvironment(env) {
  if (env.STATS_PATH) return resolve(env.STATS_PATH);
  const stateDir = (env.STATE_DIRECTORY || '').split(':')[0];
  return stateDir ? resolve(stateDir, 'stats.json') : null;
}

if (isMain) {
  const port = Number.parseInt(process.env.PORT || '8080', 10);
  const host = process.env.HOST || '0.0.0.0';
  const relay = createRelayServer({
    allowedOrigins: (process.env.ALLOWED_ORIGINS || '').split(','),
    statsPath: statsPathFromEnvironment(process.env)
  });

  relay.listen(port, host, () => {
    const address = relay.address();
    const shownHost = address && typeof address === 'object'
      ? address.address
      : host;
    const shownPort = address && typeof address === 'object'
      ? address.port
      : port;
    console.log(`Pastel Nuketown listening on http://${shownHost}:${shownPort}`);
  });

  const shutdown = async () => {
    try {
      await relay.close();
      process.exit(0);
    } catch (error) {
      console.error(error);
      process.exit(1);
    }
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}
