import {
  createHash,
  createPublicKey,
  randomBytes,
  verify as verifySignature
} from 'node:crypto';

import { headerValue, HttpError } from './http-utils.mjs';

const GOOGLE_AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const GOOGLE_ISSUERS = new Set([
  'accounts.google.com',
  'https://accounts.google.com'
]);

function requireString(value, label) {
  if (typeof value !== 'string' || !value.trim())
    throw new Error(`${label} is required.`);
  return value.trim();
}

function decodeJwtPart(encoded, label) {
  try {
    return JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  } catch (error) {
    throw new HttpError(400, 'invalid_google_token', `Google returned an invalid ${label}.`);
  }
}

function tokenHash(token) {
  return createHash('sha256').update(token, 'utf8').digest('base64url');
}

function bearerToken(headers, required) {
  const authorization = headerValue(headers, 'authorization');
  if (!authorization) {
    if (!required) return null;
    throw new HttpError(401, 'authentication_required', 'A Bearer token is required.');
  }
  const match = /^Bearer ([A-Za-z0-9_-]{20,512})$/.exec(authorization);
  if (!match)
    throw new HttpError(401, 'invalid_session', 'The session token is invalid or expired.');
  return match[1];
}

export function createAuthService(options) {
  if (!options || !options.db) throw new Error('Auth needs an account database.');
  const db = options.db;
  const clientId = requireString(options.googleClientId, 'GOOGLE_CLIENT_ID');
  const clientSecret = requireString(options.googleClientSecret, 'GOOGLE_CLIENT_SECRET');
  const redirectUri = requireString(options.googleRedirectUri, 'GOOGLE_REDIRECT_URI');
  const appOrigin = requireString(options.appOrigin, 'GAME_ORIGIN');
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('Auth needs fetch().');
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const makeRandomBytes = typeof options.randomBytes === 'function'
    ? options.randomBytes
    : randomBytes;
  const sessionTtlMs = options.sessionTtlMs || 30 * 24 * 60 * 60 * 1000;
  const stateTtlMs = options.stateTtlMs || 10 * 60 * 1000;
  const maxPendingStates = options.maxPendingStates || 10_000;
  const idTokenClockSkewSeconds = options.idTokenClockSkewSeconds ?? 60;
  const authorizeUrl = options.googleAuthorizeUrl || GOOGLE_AUTHORIZE_URL;
  const tokenUrl = options.googleTokenUrl || GOOGLE_TOKEN_URL;
  const jwksUrl = options.googleJwksUrl || GOOGLE_JWKS_URL;
  const pendingStates = new Map();
  let jwks = null;
  let jwksExpiresAt = 0;

  if (!Number.isSafeInteger(sessionTtlMs) || sessionTtlMs <= 0)
    throw new Error('sessionTtlMs must be a positive integer.');
  if (!Number.isSafeInteger(stateTtlMs) || stateTtlMs <= 0)
    throw new Error('stateTtlMs must be a positive integer.');
  if (!Number.isSafeInteger(maxPendingStates) || maxPendingStates <= 0)
    throw new Error('maxPendingStates must be a positive integer.');
  if (!Number.isSafeInteger(idTokenClockSkewSeconds) || idTokenClockSkewSeconds < 0)
    throw new Error('idTokenClockSkewSeconds must be a non-negative integer.');

  /* The state is deliberately server-side and one-use. Putting a signed blob
     in the URL would prove that we made it, but it would not prove that it had
     not already been replayed. The nonce binds Google's signed identity token
     to this same browser round trip, so neither half can be substituted from a
     different login. A restart discards pending logins; asking somebody to
     press Sign in again is safer than making replay state durable forever. */
  function startGoogleLogin() {
    const current = now();
    for (const [state, pending] of pendingStates) {
      if (pending.expiresAt <= current) pendingStates.delete(state);
    }
    /* This route is public because signing in starts before an account exists.
       Bound its only retained state so a burst of abandoned consent screens
       costs a few megabytes, not an ever-growing process. Map iteration is
       insertion ordered, making the oldest pending login the conservative one
       to discard when the cap is reached. */
    while (pendingStates.size >= maxPendingStates) {
      pendingStates.delete(pendingStates.keys().next().value);
    }

    const state = makeRandomBytes(32).toString('base64url');
    const nonce = makeRandomBytes(32).toString('base64url');
    pendingStates.set(state, { nonce, expiresAt: current + stateTtlMs });

    const target = new URL(authorizeUrl);
    target.search = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'openid email profile',
      state,
      nonce
    }).toString();
    return target.href;
  }

  async function loadJwks(force = false) {
    if (!force && jwks && jwksExpiresAt > now()) return jwks;
    let response;
    try {
      response = await fetchImpl(jwksUrl, {
        headers: { accept: 'application/json' }
      });
    } catch (error) {
      throw new HttpError(502, 'google_unavailable', 'Google identity verification is unavailable.');
    }
    if (!response.ok)
      throw new HttpError(502, 'google_unavailable', 'Google identity verification is unavailable.');

    const body = await response.json();
    if (!body || !Array.isArray(body.keys))
      throw new HttpError(502, 'google_unavailable', 'Google returned an invalid signing-key set.');

    const cacheControl = response.headers && typeof response.headers.get === 'function'
      ? response.headers.get('cache-control') || ''
      : '';
    const maxAge = /(?:^|,)\s*max-age=(\d+)/i.exec(cacheControl);
    const cacheMs = maxAge ? Number.parseInt(maxAge[1], 10) * 1000 : 60 * 60 * 1000;
    jwks = body.keys;
    jwksExpiresAt = now() + Math.max(60_000, cacheMs);
    return jwks;
  }

  async function verifyGoogleIdToken(idToken, expectedNonce) {
    if (typeof idToken !== 'string' || idToken.length > 32 * 1024)
      throw new HttpError(400, 'invalid_google_token', 'Google returned an invalid ID token.');
    const parts = idToken.split('.');
    if (parts.length !== 3)
      throw new HttpError(400, 'invalid_google_token', 'Google returned an invalid ID token.');

    const header = decodeJwtPart(parts[0], 'token header');
    const claims = decodeJwtPart(parts[1], 'token claims');
    if (!header || header.alg !== 'RS256' || typeof header.kid !== 'string')
      throw new HttpError(400, 'invalid_google_token', 'Google returned an unsupported ID token.');

    let keys = await loadJwks();
    let jwk = keys.find((candidate) => candidate && candidate.kid === header.kid);
    if (!jwk) {
      /* Google can rotate a key before our cache expires. One forced refresh
         distinguishes that ordinary rotation from a token naming a key Google
         never published. */
      keys = await loadJwks(true);
      jwk = keys.find((candidate) => candidate && candidate.kid === header.kid);
    }
    if (!jwk)
      throw new HttpError(400, 'invalid_google_token', 'Google did not sign this ID token with a current key.');

    let publicKey;
    try {
      publicKey = createPublicKey({ key: jwk, format: 'jwk' });
    } catch (error) {
      throw new HttpError(502, 'google_unavailable', 'Google returned an unusable signing key.');
    }
    const signed = Buffer.from(`${parts[0]}.${parts[1]}`, 'ascii');
    const signature = Buffer.from(parts[2], 'base64url');
    if (!verifySignature('RSA-SHA256', signed, publicKey, signature))
      throw new HttpError(400, 'invalid_google_token', 'Google ID token signature verification failed.');

    const currentSeconds = Math.floor(now() / 1000);
    if (!GOOGLE_ISSUERS.has(claims.iss))
      throw new HttpError(400, 'invalid_google_token', 'Google ID token issuer is invalid.');
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!audiences.includes(clientId) ||
        (audiences.length > 1 && claims.azp !== clientId))
      throw new HttpError(400, 'invalid_google_token', 'Google ID token audience is invalid.');
    /* Google's clocks and ours are independent. A small grace period avoids
       turning harmless clock drift at the end of a token's life into a failed
       sign-in, while still rejecting anything materially expired. */
    if (!Number.isFinite(claims.exp) ||
        claims.exp <= currentSeconds - idTokenClockSkewSeconds)
      throw new HttpError(400, 'invalid_google_token', 'Google ID token is expired.');
    if (Number.isFinite(claims.iat) && claims.iat > currentSeconds + 300)
      throw new HttpError(400, 'invalid_google_token', 'Google ID token was issued in the future.');
    if (claims.nonce !== expectedNonce)
      throw new HttpError(400, 'invalid_google_token', 'Google ID token nonce is invalid.');
    if (typeof claims.sub !== 'string' || !claims.sub ||
        typeof claims.email !== 'string' || !claims.email ||
        claims.email_verified !== true)
      throw new HttpError(400, 'invalid_google_token', 'Google ID token has no verified account identity.');
    return claims;
  }

  function issueSession(userId) {
    if (!db.getUser(userId)) throw new Error('Cannot create a session for an unknown user.');
    const token = makeRandomBytes(32).toString('base64url');
    const createdAt = now();
    const expiresAt = createdAt + sessionTtlMs;
    db.createSession({
      tokenHash: tokenHash(token),
      userId,
      createdAt,
      expiresAt
    });
    return { token, expiresAt };
  }

  async function finishGoogleLogin({ code, state }) {
    if (typeof state !== 'string' || !state)
      throw new HttpError(400, 'invalid_oauth_state', 'Google login state is missing or invalid.');
    const pending = pendingStates.get(state);
    /* Consume before contacting Google. Even a failed code exchange must not
       turn one browser login into an unlimited oracle for trying other codes. */
    pendingStates.delete(state);
    if (!pending || pending.expiresAt <= now())
      throw new HttpError(400, 'invalid_oauth_state', 'Google login state is missing, expired, or already used.');
    if (typeof code !== 'string' || !code)
      throw new HttpError(400, 'invalid_oauth_code', 'Google did not return an authorization code.');

    let response;
    try {
      response = await fetchImpl(tokenUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: redirectUri,
          grant_type: 'authorization_code'
        })
      });
    } catch (error) {
      throw new HttpError(502, 'google_unavailable', 'Google login is temporarily unavailable.');
    }
    if (!response.ok)
      throw new HttpError(400, 'invalid_oauth_code', 'Google rejected the authorization code.');
    const tokens = await response.json();
    const claims = await verifyGoogleIdToken(tokens && tokens.id_token, pending.nonce);
    const displayName = typeof claims.name === 'string' && claims.name.trim()
      ? claims.name.trim().slice(0, 200)
      : claims.email.split('@')[0].slice(0, 200);
    const user = db.upsertGoogleUser({
      subject: claims.sub.slice(0, 255),
      email: claims.email.trim().toLowerCase().slice(0, 320),
      displayName
    }, now());
    return { ...issueSession(user.id), user };
  }

  function authenticate(headers, required = true) {
    const token = bearerToken(headers, required);
    if (!token) return null;
    const hash = tokenHash(token);
    const user = db.findSessionUser(hash, now());
    if (!user)
      throw new HttpError(401, 'invalid_session', 'The session token is invalid or expired.');
    return {
      tokenHash: hash,
      userId: user.id,
      email: user.email,
      displayName: user.displayName,
      entitlements: db.listEntitlements(user.id),
      expiresAt: user.sessionExpiresAt
    };
  }

  function revokePresentedSession(headers) {
    const session = authenticate(headers, true);
    db.revokeSession(session.tokenHash, now());
  }

  function appRedirect(session) {
    const target = new URL(appOrigin);
    /* A fragment reaches the page but is never sent in an HTTP request, which
       keeps the bearer token out of Caddy access logs and the game's Netlify
       request logs. The client can copy it into localStorage and immediately
       replace the URL when the account UI lands in the next phase. */
    target.hash = new URLSearchParams({
      auth_token: session.token,
      auth_expires_at: String(session.expiresAt)
    }).toString();
    return target.href;
  }

  return {
    startGoogleLogin,
    finishGoogleLogin,
    verifyGoogleIdToken,
    issueSession,
    authenticate,
    revokePresentedSession,
    appRedirect
  };
}
