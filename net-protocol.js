(function (root, factory) {
  'use strict';

  var protocol = factory();

  if (typeof module === 'object' && module.exports) {
    module.exports = protocol;
  }
  if (root) {
    root.NUKETOWN_PROTOCOL = protocol;
  }
}(typeof globalThis !== 'undefined'
  ? globalThis
  : (typeof self !== 'undefined' ? self : this), function () {
  'use strict';

  var VERSION = 3;
  var MAX_PLAYERS = 4;
  var MAX_MESSAGE_BYTES = 64 * 1024;
  var MAX_PLAYER_NAME_LENGTH = 20;
  var ROOM_CODE_LENGTH = 6;
  var ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  var MAX_ROOM_LIST = 50;
  var ALLOWED_WEAPONS = Object.freeze(['smg', 'shotgun', 'rifle']);
  var MAX_PITCH = 1.45;
  var FIRE_INTENT_TTL = 0.2;
  var MAX_REWIND_SECONDS = 0.3;

  function result(ok, value, error) {
    return {
      ok: ok,
      value: value,
      error: error
    };
  }

  function isFiniteNumber(value) {
    return typeof value === 'number' && Number.isFinite(value);
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function wrapAngle(value) {
    if (!isFiniteNumber(value)) return 0;
    var wrapped = (value + Math.PI) % (Math.PI * 2);
    if (wrapped < 0) wrapped += Math.PI * 2;
    return wrapped - Math.PI;
  }

  function lerpAngle(from, to, amount) {
    if (!isFiniteNumber(from) || !isFiniteNumber(to)) return 0;
    if (!isFiniteNumber(amount)) amount = 0;
    return wrapAngle(from + wrapAngle(to - from) * clamp(amount, 0, 1));
  }

  function normalizeRoomCode(value) {
    if (typeof value !== 'string') return '';
    return value
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '')
      .slice(0, ROOM_CODE_LENGTH);
  }

  function cleanPlayerName(value) {
    if (typeof value !== 'string') return '';
    var name = value;
    if (typeof name.normalize === 'function') name = name.normalize('NFKC');

    name = name
      .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
      .replace(/[<>]/g, '')
      .replace(/\s+/g, ' ')
      .trim();

    return Array.from(name).slice(0, MAX_PLAYER_NAME_LENGTH).join('');
  }

  function isPrivateHost(hostname) {
    if (typeof hostname !== 'string') return false;
    var host = hostname.trim().toLowerCase();
    if (host.charAt(host.length - 1) === '.') host = host.slice(0, -1);
    if (host.charAt(0) === '[' && host.charAt(host.length - 1) === ']') {
      host = host.slice(1, -1);
    }
    host = host.split('%')[0];

    if (host === 'localhost' || host === '::1' || /\.local$/.test(host)) return true;

    var ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (ipv4) {
      var octets = ipv4.slice(1).map(Number);
      if (octets.some(function (octet) { return octet > 255; })) return false;
      return octets[0] === 127 ||
        octets[0] === 10 ||
        (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
        (octets[0] === 192 && octets[1] === 168) ||
        (octets[0] === 169 && octets[1] === 254);
    }

    if (host.indexOf(':') !== -1) {
      var firstText = host.split(':', 1)[0];
      if (!/^[0-9a-f]{1,4}$/.test(firstText)) return false;
      var first = parseInt(firstText, 16);
      return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80;
    }

    return false;
  }

  function isWeaponStateAcknowledged(localWeaponSeq, echoedWeaponSeq) {
    return Number.isSafeInteger(localWeaponSeq) && localWeaponSeq >= 0 &&
      Number.isSafeInteger(echoedWeaponSeq) && echoedWeaponSeq >= localWeaponSeq;
  }

  function classifyFireIntent(alive, sprinting, fireCd, reloadT, ammo) {
    if (!alive || sprinting) return 'drop';
    if (reloadT > 0) return 'retain';
    if (ammo <= 0) return 'drop';
    if (fireCd > 0) return 'retain';
    return 'fire';
  }

  function clampRewindTime(renderTime, hostTime, historyStart, maxAge) {
    var limit = isFiniteNumber(maxAge) && maxAge > 0
      ? maxAge
      : MAX_REWIND_SECONDS;
    if (!isFiniteNumber(renderTime) || !isFiniteNumber(hostTime) ||
        !isFiniteNumber(historyStart) || renderTime > hostTime ||
        renderTime < hostTime - limit) return null;

    return clamp(renderTime, Math.max(historyStart, hostTime - limit), hostTime);
  }

  function selectTimedSamples(samples, renderTime, maxExtrapolation) {
    if (!Array.isArray(samples) || !samples.length || !isFiniteNumber(renderTime)) {
      return null;
    }

    var first = samples[0];
    if (!first || !isFiniteNumber(first.time)) return null;
    if (renderTime <= first.time) {
      return { from: 0, to: 0, alpha: 0, extrapolation: 0 };
    }

    for (var i = 1; i < samples.length; i++) {
      var before = samples[i - 1];
      var after = samples[i];
      if (!before || !after ||
          !isFiniteNumber(before.time) || !isFiniteNumber(after.time) ||
          after.time < before.time) return null;
      if (renderTime <= after.time) {
        var span = after.time - before.time;
        return {
          from: i - 1,
          to: i,
          alpha: span > 0 ? clamp((renderTime - before.time) / span, 0, 1) : 1,
          extrapolation: 0
        };
      }
    }

    var last = samples[samples.length - 1];
    var bound = isFiniteNumber(maxExtrapolation) && maxExtrapolation > 0
      ? maxExtrapolation
      : 0;
    return {
      from: samples.length - 1,
      to: samples.length - 1,
      alpha: 0,
      extrapolation: clamp(renderTime - last.time, 0, bound)
    };
  }

  function shotSpreadSeed(shooter, fireSeq) {
    if ((typeof shooter !== 'string' && typeof shooter !== 'number') ||
        !Number.isSafeInteger(fireSeq) || fireSeq < 0) return 0;

    var text = String(shooter);
    var hash = 2166136261;
    for (var i = 0; i < text.length; i++) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    hash ^= fireSeq >>> 0;
    hash = Math.imul(hash, 16777619);
    hash ^= Math.floor(fireSeq / 4294967296) >>> 0;
    return hash >>> 0;
  }

  function createRoomCode(randomFn) {
    var random = typeof randomFn === 'function' ? randomFn : Math.random;
    var code = '';

    for (var i = 0; i < ROOM_CODE_LENGTH; i++) {
      var sample = random();
      if (!isFiniteNumber(sample)) sample = 0;
      sample = clamp(sample, 0, 1 - Number.EPSILON);
      code += ROOM_CODE_ALPHABET.charAt(Math.floor(sample * ROOM_CODE_ALPHABET.length));
    }

    return code;
  }

  /* The room browser is fetched over plain HTTP, so the payload is as
     untrusted as anything arriving on the socket. Drop entries that are
     malformed, duplicated, or no longer joinable rather than the whole list —
     one bad row should not blank the browser. */
  function cleanRoomSummaries(value, limit) {
    if (!Array.isArray(value)) return [];

    var max = Number.isSafeInteger(limit) && limit > 0 ? limit : MAX_ROOM_LIST;
    var seen = Object.create(null);
    var out = [];

    for (var i = 0; i < value.length && out.length < max; i++) {
      var raw = value[i];
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;

      var code = normalizeRoomCode(raw.code);
      if (code.length !== ROOM_CODE_LENGTH || seen[code]) continue;

      var host = cleanPlayerName(raw.host);
      if (!host) continue;

      var capacity = Number.isSafeInteger(raw.max) && raw.max > 0
        ? Math.min(raw.max, MAX_PLAYERS)
        : MAX_PLAYERS;
      if (!Number.isSafeInteger(raw.players) || raw.players < 1 ||
          raw.players >= capacity) continue;

      seen[code] = true;
      out.push({ code: code, host: host, players: raw.players, max: capacity });
    }

    return out;
  }

  function sanitizeInput(message, lastSeq, lastWeaponSeq) {
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      return result(false, null, 'input must be an object');
    }
    if (message.t !== 'input') {
      return result(false, null, 'unexpected message type');
    }
    if (message.v !== VERSION) {
      return result(false, null, 'unsupported protocol version');
    }
    if (!Number.isSafeInteger(message.seq) || message.seq < 0) {
      return result(false, null, 'seq must be a non-negative safe integer');
    }
    if (!Number.isSafeInteger(message.round) || message.round < 1) {
      return result(false, null, 'round must be a positive safe integer');
    }

    var previous = Number.isSafeInteger(lastSeq) ? lastSeq : -1;
    if (message.seq <= previous) {
      return result(false, null, 'seq must increase');
    }

    if (!isFiniteNumber(message.fwd) || !isFiniteNumber(message.strafe)) {
      return result(false, null, 'movement axes must be finite numbers');
    }
    if (!isFiniteNumber(message.yaw) || !isFiniteNumber(message.pitch)) {
      return result(false, null, 'look angles must be finite numbers');
    }
    if (!isFiniteNumber(message.renderTime) ||
        message.renderTime < 0 || message.renderTime > 100000000) {
      return result(false, null, 'renderTime must be a plausible host timestamp');
    }
    if (typeof message.jump !== 'boolean' ||
        typeof message.sprint !== 'boolean' ||
        typeof message.fire !== 'boolean') {
      return result(false, null, 'input buttons must be booleans');
    }
    if (ALLOWED_WEAPONS.indexOf(message.weapon) === -1) {
      return result(false, null, 'unknown weapon');
    }
    if (!Number.isSafeInteger(message.fireSeq) || message.fireSeq < 0 ||
        !Number.isSafeInteger(message.reloadSeq) || message.reloadSeq < 0 ||
        !Number.isSafeInteger(message.weaponSeq) || message.weaponSeq < 0) {
      return result(false, null, 'action counters must be non-negative safe integers');
    }
    var previousWeapon = Number.isSafeInteger(lastWeaponSeq) ? lastWeaponSeq : -1;
    if (message.weaponSeq < previousWeapon) {
      return result(false, null, 'weaponSeq must not decrease');
    }

    return result(true, {
      t: 'input',
      v: VERSION,
      round: message.round,
      seq: message.seq,
      fwd: clamp(message.fwd, -1, 1),
      strafe: clamp(message.strafe, -1, 1),
      jump: message.jump,
      sprint: message.sprint,
      fire: message.fire,
      fireSeq: message.fireSeq,
      yaw: wrapAngle(message.yaw),
      pitch: clamp(message.pitch, -MAX_PITCH, MAX_PITCH),
      renderTime: message.renderTime,
      weapon: message.weapon,
      weaponSeq: message.weaponSeq,
      reloadSeq: message.reloadSeq
    }, null);
  }

  function utf8Size(text) {
    if (typeof TextEncoder !== 'undefined') {
      return new TextEncoder().encode(text).byteLength;
    }
    if (typeof Buffer !== 'undefined') {
      return Buffer.byteLength(text, 'utf8');
    }

    return unescape(encodeURIComponent(text)).length;
  }

  function decodeBytes(raw) {
    var bytes;

    if (typeof ArrayBuffer !== 'undefined' && raw instanceof ArrayBuffer) {
      bytes = new Uint8Array(raw);
    } else if (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView(raw)) {
      bytes = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
    } else {
      return null;
    }

    if (typeof TextDecoder !== 'undefined') {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    }
    if (typeof Buffer !== 'undefined') {
      return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('utf8');
    }

    var encoded = '';
    for (var i = 0; i < bytes.length; i++) {
      encoded += '%' + bytes[i].toString(16).padStart(2, '0');
    }
    return decodeURIComponent(encoded);
  }

  function parseWireMessage(raw, maxBytes) {
    var limit = maxBytes === undefined ? MAX_MESSAGE_BYTES : maxBytes;
    if (!Number.isSafeInteger(limit) || limit <= 0) {
      return result(false, null, 'maxBytes must be a positive integer');
    }

    var text;
    var size;

    try {
      if (typeof raw === 'string') {
        text = raw;
        size = utf8Size(text);
      } else {
        if (raw === null || raw === undefined ||
            typeof raw.byteLength !== 'number') {
          return result(false, null, 'wire message must be text or bytes');
        }
        size = raw.byteLength;
        if (size > limit) {
          return result(false, null, 'message is too large');
        }
        text = decodeBytes(raw);
        if (text === null) {
          return result(false, null, 'wire message must be text or bytes');
        }
      }
    } catch (error) {
      return result(false, null, 'message is not valid UTF-8');
    }

    if (size > limit) {
      return result(false, null, 'message is too large');
    }
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

    var value;
    try {
      value = JSON.parse(text);
    } catch (error) {
      return result(false, null, 'message is not valid JSON');
    }

    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return result(false, null, 'message must be a JSON object');
    }

    return result(true, value, null);
  }

  return Object.freeze({
    VERSION: VERSION,
    MAX_PLAYERS: MAX_PLAYERS,
    MAX_MESSAGE_BYTES: MAX_MESSAGE_BYTES,
    MAX_PLAYER_NAME_LENGTH: MAX_PLAYER_NAME_LENGTH,
    ROOM_CODE_LENGTH: ROOM_CODE_LENGTH,
    ROOM_CODE_ALPHABET: ROOM_CODE_ALPHABET,
    MAX_ROOM_LIST: MAX_ROOM_LIST,
    ALLOWED_WEAPONS: ALLOWED_WEAPONS,
    MAX_PITCH: MAX_PITCH,
    FIRE_INTENT_TTL: FIRE_INTENT_TTL,
    MAX_REWIND_SECONDS: MAX_REWIND_SECONDS,
    normalizeRoomCode: normalizeRoomCode,
    cleanPlayerName: cleanPlayerName,
    isPrivateHost: isPrivateHost,
    isWeaponStateAcknowledged: isWeaponStateAcknowledged,
    classifyFireIntent: classifyFireIntent,
    clampRewindTime: clampRewindTime,
    selectTimedSamples: selectTimedSamples,
    shotSpreadSeed: shotSpreadSeed,
    cleanRoomSummaries: cleanRoomSummaries,
    createRoomCode: createRoomCode,
    isFiniteNumber: isFiniteNumber,
    clamp: clamp,
    wrapAngle: wrapAngle,
    lerpAngle: lerpAngle,
    sanitizeInput: sanitizeInput,
    parseWireMessage: parseWireMessage
  });
}));
