import { randomInt, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { WebSocket, WebSocketServer } from 'ws';
import Protocol from './net-protocol.js';

const ROOT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_INDEX_PATH = resolve(ROOT_DIR, 'index.html');
const DEFAULT_PROTOCOL_PATH = resolve(ROOT_DIR, 'net-protocol.js');

const RELAY_TYPES = new Set(['snapshot', 'event']);

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
  const makeId = typeof options.idFactory === 'function'
    ? options.idFactory
    : randomUUID;
  const roomRandom = typeof options.roomRandom === 'function'
    ? options.roomRandom
    : secureRandom;

  const rooms = new Map();
  const peers = new Map();

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

  /* The room browser only ever advertises rooms you could actually walk into
     right now: opted in to listing, still between rounds, and with a seat
     free. A room that fails any of those is simply absent rather than shown
     and then refused on click. */
  function listedRooms() {
    const out = [];

    for (const room of rooms.values()) {
      if (out.length >= maxListedRooms) break;
      if (!room.listed || room.started || !room.host) continue;
      if (room.members.size >= Protocol.MAX_PLAYERS) continue;

      out.push({
        code: room.code,
        host: room.host.name,
        players: room.members.size,
        max: Protocol.MAX_PLAYERS
      });
    }

    return out;
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
      const body = Buffer.from(JSON.stringify({ rooms: listedRooms() }), 'utf8');
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
      members: memberList(room)
    });

    for (const peer of room.members.values()) {
      sendEncoded(peer, encoded);
    }
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
    room.members.set(peer.id, peer);
    if (role === 'host') room.host = peer;
  }

  /* The round is part of the handshake, not just of `start`. A player who
     joins a room that has already run a round starts from that room's round,
     so the next `start` they see is the expected step forward. Without this a
     late joiner sits in the lobby ignoring every start it is sent. */
  function roomReply(peer) {
    send(peer, {
      t: 'room',
      v: Protocol.VERSION,
      room: peer.room.code,
      id: peer.id,
      role: peer.role,
      round: peer.room.round,
      members: memberList(peer.room)
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
    if (room.started) {
      sendError(peer, 'match-started', 'That match has already started.');
      return;
    }
    if (room.members.size >= Protocol.MAX_PLAYERS) {
      sendError(peer, 'room-full', 'That room is full.');
      return;
    }

    enterRoom(peer, room, 'guest', name);
    roomReply(peer);
    broadcastMembers(room);
  }

  function handleGuestInput(peer, message) {
    if (!peer.room.started || message.round !== peer.room.round) return;
    const sanitized = Protocol.sanitizeInput(message, peer.lastSeq);
    if (!sanitized.ok) {
      sendError(peer, 'invalid-input', sanitized.error);
      return;
    }

    peer.lastSeq = sanitized.value.seq;
    send(peer.room.host, {
      ...sanitized.value,
      from: peer.id
    });
  }

  function handleRoomMessage(peer, message) {
    if (message.t === 'create' || message.t === 'join') {
      sendError(peer, 'already-in-room', 'Leave this room before joining another.');
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
      if (peer.room.started) {
        sendError(peer, 'already-started', 'The match is already running.');
        return;
      }
      peer.room.started = true;
      peer.room.round++;
      for (const member of peer.room.members.values()) member.lastSeq = -1;
      const start = {
        t: 'start',
        v: Protocol.VERSION,
        round: peer.room.round,
        members: memberList(peer.room)
      };
      broadcastRoom(peer.room, start, true);
      return;
    }

    if (message.t === 'lobby') {
      if (peer.role !== 'host') {
        sendError(peer, 'host-only', 'Only the host can end a round.');
        return;
      }
      if (!peer.room.started || message.round !== peer.room.round) return;
      peer.room.started = false;
      broadcastRoom(peer.room, {
        t: 'lobby',
        v: Protocol.VERSION,
        round: peer.room.round,
        winner: typeof message.winner === 'string' ? message.winner.slice(0, 80) : null
      });
      return;
    }

    if (RELAY_TYPES.has(message.t)) {
      if (peer.role !== 'host') {
        sendError(peer, 'host-only', 'Only the host can send match state.');
        return;
      }
      if (!peer.room.started || message.round !== peer.room.round) return;
      if (message.t === 'snapshot' &&
          (!Number.isSafeInteger(message.tick) || !Array.isArray(message.actors) ||
           message.actors.length > 16)) {
        sendError(peer, 'invalid-snapshot', 'Invalid snapshot.');
        return;
      }
      if (message.t === 'event' &&
          (!Array.isArray(message.events) || message.events.length > 256)) {
        sendError(peer, 'invalid-event', 'Invalid event batch.');
        return;
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
      sendError(peer, 'version', 'Unsupported protocol version.');
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

  function closeHostedRoom(room) {
    rooms.delete(room.code);
    const encoded = encode({
      t: 'room-closed',
      v: Protocol.VERSION
    });

    for (const member of room.members.values()) {
      if (member.role === 'guest') sendEncoded(member, encoded);
      member.room = null;
      member.role = null;
      member.name = '';
      member.lastSeq = -1;
    }
    room.members.clear();
    room.host = null;
  }

  function leaveRoom(peer) {
    const room = peer.room;
    if (!room) return;

    if (peer.role === 'host') {
      closeHostedRoom(room);
      return;
    }

    room.members.delete(peer.id);
    peer.room = null;
    peer.role = null;
    peer.name = '';
    peer.lastSeq = -1;
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
      joinTimer: null
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

if (isMain) {
  const port = Number.parseInt(process.env.PORT || '8080', 10);
  const host = process.env.HOST || '0.0.0.0';
  const relay = createRelayServer({
    allowedOrigins: (process.env.ALLOWED_ORIGINS || '').split(',')
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
