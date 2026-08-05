import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { isIP } from 'node:net';

const STORE_VERSION = 1;
const MAX_BANS = 10_000;

function cleanText(value, maxLength) {
  if (typeof value !== 'string') return '';
  return value.trim().replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, maxLength);
}

export function normalizeClientAddress(value) {
  if (typeof value !== 'string') return null;
  let address = value.trim().toLowerCase();
  if (address.startsWith('::ffff:') && isIP(address.slice(7)) === 4)
    address = address.slice(7);
  const scope = address.indexOf('%');
  if (scope !== -1) address = address.slice(0, scope);
  return isIP(address) ? address : null;
}

/* Caddy is the only production caller of the loopback listener and authors
   X-Forwarded-For there. Direct/LAN relays use the socket address. Never trust
   a forwarded value from a non-loopback peer: that would turn the ban identity
   into a string the player gets to choose. */
export function clientAddressFromRequest(request) {
  const socketAddress = normalizeClientAddress(
    request && request.socket && request.socket.remoteAddress
  );
  const loopback = socketAddress === '127.0.0.1' || socketAddress === '::1';
  if (loopback) {
    const raw = request && request.headers && request.headers['x-forwarded-for'];
    const forwarded = typeof raw === 'string' ? raw.split(',')[0] : null;
    const address = normalizeClientAddress(forwarded);
    if (address) return address;
  }
  return socketAddress;
}

function validStoredBan(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (typeof value.id !== 'string' || !/^[A-Za-z0-9_-]{8,80}$/.test(value.id)) return false;
  if (typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt))) return false;
  if (typeof value.name !== 'string' || value.name.length > 80) return false;
  if (typeof value.reason !== 'string' || value.reason.length > 200) return false;
  const validHashes = (hashes) => Array.isArray(hashes) && hashes.length <= 32 &&
    new Set(hashes).size === hashes.length &&
    hashes.every((hash) => typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash));
  if (!validHashes(value.accountHashes) || !validHashes(value.networkHashes)) return false;
  return !!(value.accountHashes.length || value.networkHashes.length);
}

export function createBanRegistry(options = {}) {
  const filePath = typeof options.path === 'string' && options.path ? options.path : null;
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const makeId = typeof options.idFactory === 'function' ? options.idFactory : randomUUID;
  let salt = randomBytes(32).toString('base64url');
  let bans = [];

  if (filePath) {
    try {
      const saved = JSON.parse(readFileSync(filePath, 'utf8'));
      if (!saved || saved.version !== STORE_VERSION ||
          typeof saved.salt !== 'string' || !/^[A-Za-z0-9_-]{32,80}$/.test(saved.salt) ||
          !Array.isArray(saved.bans) || saved.bans.length > MAX_BANS ||
          !saved.bans.every(validStoredBan)) {
        throw new Error('unexpected ban store shape');
      }
      const ids = new Set(saved.bans.map((ban) => ban.id));
      if (ids.size !== saved.bans.length) throw new Error('duplicate ban ids');
      salt = saved.salt;
      bans = saved.bans.map((ban) => ({ ...ban }));
    } catch (error) {
      if (!error || error.code !== 'ENOENT') {
        throw new Error(`Could not read ban store ${filePath}: ${error.message}`);
      }
    }
  }

  function hash(kind, value) {
    if (typeof value !== 'string' || !value) return null;
    return createHash('sha256').update(salt).update('\0').update(kind)
      .update('\0').update(value).digest('hex');
  }

  function networkHash(address) {
    const normalized = normalizeClientAddress(address);
    return normalized ? hash('network', normalized) : null;
  }

  function persist(nextBans) {
    if (!filePath) {
      bans = nextBans;
      return;
    }
    const temp = `${filePath}.${process.pid}.tmp`;
    const body = `${JSON.stringify({ version: STORE_VERSION, salt, bans: nextBans }, null, 2)}\n`;
    writeFileSync(temp, body, { mode: 0o600 });
    renameSync(temp, filePath);
    bans = nextBans;
  }

  function identifiers(subject) {
    const accountId = typeof subject.userId === 'string' && subject.userId
      ? subject.userId.slice(0, 200)
      : null;
    return {
      accountHash: accountId ? hash('account', accountId) : null,
      networkHash: networkHash(subject.address)
    };
  }

  function match(subject) {
    const ids = identifiers(subject || {});
    if (!ids.accountHash && !ids.networkHash) return null;
    return bans.find((ban) =>
      (ids.accountHash && ban.accountHashes.includes(ids.accountHash)) ||
      (ids.networkHash && ban.networkHashes.includes(ids.networkHash))
    ) || null;
  }

  function publicBan(ban) {
    return {
      id: ban.id,
      createdAt: ban.createdAt,
      name: ban.name,
      reason: ban.reason,
      account: ban.accountHashes.length
        ? ban.accountHashes.map((value) => value.slice(0, 12)).join(',')
        : null,
      network: ban.networkHashes.length
        ? ban.networkHashes.map((value) => value.slice(0, 12)).join(',')
        : null
    };
  }

  function add(subject, reason = '') {
    const ids = identifiers(subject || {});
    if (!ids.accountHash && !ids.networkHash)
      throw new Error('That connection has no enforceable account or network identity.');

    const existing = match(subject);
    if (existing) {
      const updated = {
        ...existing,
        name: cleanText(subject.name, 80) || existing.name,
        reason: cleanText(reason, 200) || existing.reason,
        accountHashes: Array.from(new Set([
          ...existing.accountHashes,
          ...(ids.accountHash ? [ids.accountHash] : [])
        ])).slice(-32),
        networkHashes: Array.from(new Set([
          ...existing.networkHashes,
          ...(ids.networkHash ? [ids.networkHash] : [])
        ])).slice(-32)
      };
      persist(bans.map((ban) => ban.id === existing.id ? updated : ban));
      return { ban: publicBan(updated), created: false };
    }

    if (bans.length >= MAX_BANS) throw new Error('The ban store is full.');
    let id = '';
    for (let attempt = 0; attempt < 128; attempt++) {
      const candidate = String(makeId());
      if (!bans.some((ban) => ban.id === candidate)) {
        id = candidate;
        break;
      }
    }
    if (!id) throw new Error('Could not allocate a unique ban id.');
    const ban = {
      id,
      createdAt: new Date(now()).toISOString(),
      name: cleanText(subject.name, 80),
      reason: cleanText(reason, 200),
      accountHashes: ids.accountHash ? [ids.accountHash] : [],
      networkHashes: ids.networkHash ? [ids.networkHash] : []
    };
    if (!validStoredBan(ban)) throw new Error('Could not construct a valid ban record.');
    persist([...bans, ban]);
    return { ban: publicBan(ban), created: true };
  }

  function remove(selector) {
    const wanted = cleanText(selector, 80);
    if (!wanted) return { status: 'missing', matches: [] };
    const exact = bans.filter((ban) => ban.id === wanted);
    const matches = exact.length ? exact : bans.filter((ban) => ban.id.startsWith(wanted));
    if (matches.length !== 1) {
      return {
        status: matches.length ? 'ambiguous' : 'missing',
        matches: matches.map(publicBan)
      };
    }
    persist(bans.filter((ban) => ban.id !== matches[0].id));
    return { status: 'removed', ban: publicBan(matches[0]) };
  }

  return Object.freeze({
    add,
    match,
    remove,
    list: () => bans.map(publicBan),
    networkFingerprint: (address) => {
      const value = networkHash(address);
      return value ? value.slice(0, 12) : null;
    }
  });
}
