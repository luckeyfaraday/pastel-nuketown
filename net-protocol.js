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

  /* 7: a room seats nine, so a full lobby can be nine real players and no
     bots at all. Two reasons this cannot be additive. A version 6 peer
     refuses any roster longer than four outright — it would watch the fifth
     arrival and then ignore every roster message for the rest of the match.
     And members now carry `slot`, the jersey the relay reserved for them; a
     peer that ignores the field falls back to colouring by roster position,
     which puts two identically dressed players on the map the first time
     somebody leaves mid-round.

     6: a room admits players mid-round. The handshake gained `started`, but
     the reason this is a bump rather than an additive field is the host: a
     version 5 host receiving a mid-round roster change seats nobody, and the
     arrival becomes a ghost sending input no authority ever applies. Refusing
     the handshake is the only honest outcome, so old and new must not mix. */
  var VERSION = 7;
  /* Nine seats, because nine is how many combatants the match runs. Any
     smaller and the shortfall is made up with bots no matter how popular the
     room gets, which is the one thing a full room should not have to do. */
  var MAX_PLAYERS = 9;
  var MAX_MESSAGE_BYTES = 64 * 1024;
  var MAX_PLAYER_NAME_LENGTH = 20;
  var ROOM_CODE_LENGTH = 6;
  var ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  var MAX_ROOM_LIST = 50;
  var ALLOWED_WEAPONS = Object.freeze(['smg', 'shotgun', 'rifle']);
  var MAX_PITCH = 1.45;
  var FIRE_INTENT_TTL = 0.2;
  var MAX_REWIND_SECONDS = 0.3;

  /* How long a guest keeps an unmatched predicted hit before writing it off.
     One round trip plus slack: long enough that the authoritative answer to a
     shot has certainly arrived, short enough that a hit the host denied cannot
     linger and swallow the marker for some later shot. */
  var PREDICTED_HIT_TTL = 0.8;
  var MAX_PREDICTED_SHOTS = 24;

  /* Bounds on the guest's interpolation buffer, in snapshot intervals.

     The floor is above 1 so there is always a bracketing pair to interpolate
     between rather than a sample the renderer has to extrapolate past. The
     ceiling stops a burst of jitter from parking the guest so far in the past
     that it loses more from seeing late than it gains from a smooth replica. */
  var MIN_INTERP_SNAPSHOTS = 1.15;
  var MAX_INTERP_SNAPSHOTS = 3;
  var JITTER_DECAY = 0.05;

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

  /* A seat in the room, reserved by the relay and held until its occupant
     leaves. It is what a player's jersey is drawn from, which is why it is
     not simply their position in the roster: positions shift under everyone
     below when somebody leaves mid-round, and a colour that shifts with them
     is a colour that lands on a player already wearing it. */
  function validSlot(value) {
    return Number.isSafeInteger(value) && value >= 0 && value < MAX_PLAYERS;
  }

  function isAuthorityEpoch(value) {
    return Number.isSafeInteger(value) && value > 0;
  }

  /* A host change is a server-authored authority transition. Validate the
     complete roster here so clients change roles only when the epoch and the
     cancelled-round barrier both move forward together. */
  function sanitizeHostChanged(message, localId, previousEpoch, previousRound) {
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      return result(false, null, 'host change must be an object');
    }
    if (message.t !== 'host-changed') {
      return result(false, null, 'unexpected message type');
    }
    if (message.v !== VERSION) {
      return result(false, null, 'unsupported protocol version');
    }

    var priorEpoch = isAuthorityEpoch(previousEpoch) ? previousEpoch : 0;
    if (!isAuthorityEpoch(message.authorityEpoch) ||
        message.authorityEpoch <= priorEpoch) {
      return result(false, null, 'authorityEpoch must increase');
    }

    var priorRound = Number.isSafeInteger(previousRound) && previousRound >= 0
      ? previousRound
      : -1;
    var seamless = message.seamless === true;
    if (!Number.isSafeInteger(message.round) || message.round < 0 ||
        (seamless ? message.round !== priorRound : message.round <= priorRound)) {
      return result(false, null, seamless
        ? 'seamless host change must preserve round'
        : 'round must increase');
    }
    if (seamless &&
        (!message.snapshot || typeof message.snapshot !== 'object' ||
         Array.isArray(message.snapshot) ||
         !message.checkpoint || typeof message.checkpoint !== 'object' ||
         Array.isArray(message.checkpoint))) {
      return result(false, null, 'seamless host change requires migration state');
    }
    if (typeof message.host !== 'string' || !message.host ||
        message.host.length > 80) {
      return result(false, null, 'host id is invalid');
    }
    if (!Array.isArray(message.members) || message.members.length < 1 ||
        message.members.length > MAX_PLAYERS) {
      return result(false, null, 'members are invalid');
    }

    var seen = Object.create(null);
    var slots = Object.create(null);
    var members = [];
    var hosts = 0;
    var includesLocal = typeof localId !== 'string' || !localId;
    for (var i = 0; i < message.members.length; i++) {
      var raw = message.members[i];
      if (!raw || typeof raw !== 'object' || Array.isArray(raw) ||
          typeof raw.id !== 'string' || !raw.id || raw.id.length > 80 ||
          seen[raw.id] || (raw.role !== 'host' && raw.role !== 'guest')) {
        return result(false, null, 'member is invalid');
      }
      var name = cleanPlayerName(raw.name);
      if (!name) return result(false, null, 'member name is invalid');
      /* Two players in one jersey is not a cosmetic problem in a shooter, so
         a roster that hands the same slot out twice is refused rather than
         cleaned up: whatever produced it is not tracking the room. */
      if (!validSlot(raw.slot) || slots[raw.slot]) {
        return result(false, null, 'member slot is invalid');
      }

      seen[raw.id] = true;
      slots[raw.slot] = true;
      if (raw.role === 'host') {
        hosts++;
        if (raw.id !== message.host) {
          return result(false, null, 'host does not match roster');
        }
      }
      if (raw.id === localId) includesLocal = true;
      members.push({ id: raw.id, name: name, role: raw.role, slot: raw.slot });
    }
    if (hosts !== 1 || !seen[message.host] || !includesLocal) {
      return result(false, null, 'host change roster is incomplete');
    }

    var change = {
      t: 'host-changed',
      v: VERSION,
      authorityEpoch: message.authorityEpoch,
      round: message.round,
      host: message.host,
      members: members
    };
    if (seamless) {
      change.seamless = true;
      change.snapshot = message.snapshot;
      change.checkpoint = message.checkpoint;
    }
    return result(true, change, null);
  }

  function sanitizeAuthorityState(message) {
    if (!message || typeof message !== 'object' || Array.isArray(message) ||
        message.t !== 'authority-state' || message.v !== VERSION ||
        !isAuthorityEpoch(message.authorityEpoch) ||
        !Number.isSafeInteger(message.round) || message.round < 0) {
      return result(false, null, 'authority state header is invalid');
    }
    var counters = ['inputSeq', 'fireSeq', 'reloadSeq', 'weaponSeq'];
    for (var i = 0; i < counters.length; i++) {
      if (!Number.isSafeInteger(message[counters[i]]) ||
          message[counters[i]] < 0 || message[counters[i]] > 0x7fffffff) {
        return result(false, null, counters[i] + ' is invalid');
      }
    }
    if (ALLOWED_WEAPONS.indexOf(message.weapon) < 0) {
      return result(false, null, 'weapon is invalid');
    }
    return result(true, {
      t: 'authority-state',
      v: VERSION,
      authorityEpoch: message.authorityEpoch,
      round: message.round,
      inputSeq: message.inputSeq,
      fireSeq: message.fireSeq,
      reloadSeq: message.reloadSeq,
      weaponSeq: message.weaponSeq,
      weapon: message.weapon
    }, null);
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

  /* Snapshots leave the host on a fixed clock but arrive on the network's, so
     the guest sizes its interpolation buffer from how late they actually run.
     Only lateness is tracked: a snapshot arriving early is already absorbed by
     the buffer, while one arriving late is what leaves the renderer without a
     sample to interpolate toward. */
  function trackArrivalJitter(previous, gap, interval) {
    var last = isFiniteNumber(previous) && previous > 0 ? previous : 0;
    if (!isFiniteNumber(gap) || !isFiniteNumber(interval) || interval <= 0) {
      return last;
    }
    var late = clamp(gap - interval, 0, interval * MAX_INTERP_SNAPSHOTS);
    /* Grow to a spike at once and give the margin back slowly. Being one sample
       short is a visible stutter; holding a few extra milliseconds is not, so
       the two directions are deliberately not symmetric. */
    return late > last ? late : last + (late - last) * JITTER_DECAY;
  }

  /* One snapshot interval is the minimum that guarantees a bracketing pair;
     everything above it is margin bought against observed lateness. Doubling
     the smoothed figure covers the tail without tracking a full distribution. */
  function interpolationDelay(interval, jitter) {
    if (!isFiniteNumber(interval) || interval <= 0) return 0;
    var margin = isFiniteNumber(jitter) && jitter > 0 ? jitter : 0;
    return clamp(
      interval + margin * 2,
      interval * MIN_INTERP_SNAPSHOTS,
      interval * MAX_INTERP_SNAPSHOTS);
  }

  /* A guest shows its own hitmarker the moment its local hitscan lands, rather
     than waiting a round trip for the host to agree. The host's damage event
     still arrives, and would fire the same feedback a second time, so each
     predicted hit is booked here and the matching event redeems it.

     Keyed by fireSeq because a shotgun lands several pellets on one trigger
     press and each becomes its own event: the count has to match, not just the
     fact of a hit. Keying also contains a misprediction — a hit the host denied
     expires against its own shot instead of eating some later shot's marker. */
  function prunePredictedHits(ledger, now) {
    for (var i = ledger.length - 1; i >= 0; i--) {
      if (!(ledger[i].expires > now)) ledger.splice(i, 1);
    }
    if (ledger.length > MAX_PREDICTED_SHOTS) {
      ledger.splice(0, ledger.length - MAX_PREDICTED_SHOTS);
    }
  }

  function recordPredictedHit(ledger, fireSeq, now) {
    if (!Array.isArray(ledger) || !isFiniteNumber(now) ||
        !Number.isSafeInteger(fireSeq) || fireSeq < 0) return false;
    prunePredictedHits(ledger, now);
    for (var i = 0; i < ledger.length; i++) {
      if (ledger[i].seq === fireSeq) {
        ledger[i].count++;
        ledger[i].expires = now + PREDICTED_HIT_TTL;
        return true;
      }
    }
    ledger.push({ seq: fireSeq, count: 1, expires: now + PREDICTED_HIT_TTL });
    return true;
  }

  /* True when this authoritative hit was already shown locally, so the caller
     should stay quiet rather than double up. */
  function consumePredictedHit(ledger, fireSeq, now) {
    if (!Array.isArray(ledger) || !isFiniteNumber(now) ||
        !Number.isSafeInteger(fireSeq) || fireSeq < 0) return false;
    prunePredictedHits(ledger, now);
    for (var i = 0; i < ledger.length; i++) {
      if (ledger[i].seq !== fireSeq) continue;
      if (--ledger[i].count <= 0) ledger.splice(i, 1);
      return true;
    }
    return false;
  }

  /* fireSeq alone is not enough to key a shot. It advances on a fresh trigger
     press, so every shot in a held automatic burst would reseed identically and
     the spread cone would collapse to one fixed offset. `shotNo` separates the
     shots inside a burst: pass the firing actor's remaining ammo, which counts
     down once per shot and is both locally predicted and host-authoritative, so
     the two sides still derive the same seed. */
  function shotSpreadSeed(shooter, fireSeq, shotNo) {
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
    if (Number.isSafeInteger(shotNo) && shotNo >= 0) {
      hash = Math.imul(hash, 16777619);
      hash ^= shotNo >>> 0;
    }
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
     malformed, duplicated, or impossible rather than the whole list — one bad
     row should not blank the browser.

     `inProgress` rooms are listed but not joinable: a room disappearing the
     moment it got interesting is what made the browser read empty while people
     were playing. They are the only rows allowed to be full, since a running
     room's seats say nothing about whether you could take one. */
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
      var inProgress = raw.inProgress === true;
      if (!Number.isSafeInteger(raw.players) || raw.players < 1 ||
          raw.players > capacity ||
          (!inProgress && raw.players === capacity)) continue;

      seen[code] = true;
      out.push({
        code: code,
        host: host,
        players: raw.players,
        max: capacity,
        inProgress: inProgress
      });
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
    if (!isAuthorityEpoch(message.authorityEpoch)) {
      return result(false, null, 'authorityEpoch must be a positive safe integer');
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
      authorityEpoch: message.authorityEpoch,
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
    PREDICTED_HIT_TTL: PREDICTED_HIT_TTL,
    MIN_INTERP_SNAPSHOTS: MIN_INTERP_SNAPSHOTS,
    MAX_INTERP_SNAPSHOTS: MAX_INTERP_SNAPSHOTS,
    normalizeRoomCode: normalizeRoomCode,
    cleanPlayerName: cleanPlayerName,
    validSlot: validSlot,
    isAuthorityEpoch: isAuthorityEpoch,
    sanitizeHostChanged: sanitizeHostChanged,
    sanitizeAuthorityState: sanitizeAuthorityState,
    isPrivateHost: isPrivateHost,
    isWeaponStateAcknowledged: isWeaponStateAcknowledged,
    classifyFireIntent: classifyFireIntent,
    clampRewindTime: clampRewindTime,
    selectTimedSamples: selectTimedSamples,
    trackArrivalJitter: trackArrivalJitter,
    interpolationDelay: interpolationDelay,
    recordPredictedHit: recordPredictedHit,
    consumePredictedHit: consumePredictedHit,
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
