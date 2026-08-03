import { resolve } from 'node:path';

import { createAuthService } from './auth.mjs';
import { COSMETICS } from './cosmetics.mjs';
import {
  headerValue,
  HttpError,
  readJsonBody,
  readRequestBody,
  sendJson
} from './http-utils.mjs';
import { createShopService } from './shop.mjs';
import { openStoreDatabase } from './store-db.mjs';

const ROUTE_METHODS = new Map([
  ['/auth/google/start', 'GET'],
  ['/auth/google/callback', 'GET'],
  ['/auth/me', 'GET'],
  ['/auth/logout', 'POST'],
  ['/shop/catalog', 'GET'],
  ['/shop/checkout', 'POST'],
  ['/stripe/webhook', 'POST']
]);

function normalizedOrigin(origin) {
  return String(origin || '').trim().replace(/\/+$/, '').toLowerCase();
}

function requiredEnvironment(env, names) {
  const missing = names.filter((name) => typeof env[name] !== 'string' || !env[name].trim());
  if (missing.length)
    throw new Error(`Missing account/store configuration: ${missing.join(', ')}`);
}

export function storePathFromEnvironment(env) {
  if (env.STORE_DB_PATH) return resolve(env.STORE_DB_PATH);
  const stateDir = (env.STATE_DIRECTORY || '').split(':')[0];
  if (!stateDir)
    throw new Error('Missing account/store configuration: STATE_DIRECTORY (or STORE_DB_PATH)');
  return resolve(stateDir, 'accounts.sqlite');
}

export function createAccountStore(options = {}) {
  const origins = (Array.isArray(options.allowedOrigins) ? options.allowedOrigins : [])
    .map((origin) => String(origin).trim())
    .filter(Boolean);
  const allowedOrigins = new Map(origins.map((origin) => [normalizedOrigin(origin), origin]));
  if (allowedOrigins.size === 0) {
    /* Bearer tokens remove the need for cookies, not the need to say which
       pages may read account responses. The relay's empty allowlist is useful
       for LAN games, but account routes have no safe meaning for "every site",
       so enabling this service without an allowlist is a boot error. */
    throw new Error('Account/store routes require at least one ALLOWED_ORIGINS entry.');
  }

  const ownsDatabase = !options.db;
  const db = options.db || openStoreDatabase(options.dbPath, options.databaseOptions);
  const auth = createAuthService({
    db,
    googleClientId: options.googleClientId,
    googleClientSecret: options.googleClientSecret,
    googleRedirectUri: options.googleRedirectUri,
    appOrigin: options.appOrigin,
    fetchImpl: options.fetchImpl,
    now: options.now,
    ...(options.authOptions || {})
  });
  const shop = createShopService({
    db,
    stripeSecretKey: options.stripeSecretKey,
    stripeWebhookSecret: options.stripeWebhookSecret,
    appOrigin: options.appOrigin,
    priceIds: options.priceIds,
    fetchImpl: options.fetchImpl,
    now: options.now,
    ...(options.shopOptions || {})
  });
  let closed = false;

  function corsHeaders(request) {
    const origin = headerValue(request.headers, 'origin');
    if (!origin) return {};
    if (!allowedOrigins.has(normalizedOrigin(origin)))
      throw new HttpError(403, 'origin_not_allowed', 'This origin is not allowed to use account routes.');
    return {
      'access-control-allow-origin': origin,
      vary: 'Origin'
    };
  }

  function methodNotAllowed(response, allow, headers) {
    sendJson(response, 405, {
      error: 'method_not_allowed',
      message: 'Method not allowed.'
    }, { ...headers, allow });
  }

  async function handleHttp(request, response, requestUrl) {
    const pathname = requestUrl.pathname;
    const routeMethod = ROUTE_METHODS.get(pathname);
    if (!routeMethod) return false;

    let headers = {};
    try {
      /* Google and Stripe arrive as server navigations/callbacks, not as page
         fetches. OAuth is protected by the consumed state above and Stripe by
         its signed raw body. CORS applies to the routes the game JavaScript can
         read; applying it to Google's return trip would confuse navigation
         provenance with script authority. */
      const corsProtected = pathname !== '/auth/google/callback' &&
        pathname !== '/stripe/webhook';
      if (corsProtected) headers = corsHeaders(request);

      if (request.method === 'OPTIONS') {
        if (!corsProtected) {
          methodNotAllowed(response, routeMethod, headers);
          return true;
        }
        response.writeHead(204, {
          ...headers,
          'access-control-allow-headers': 'Authorization, Content-Type',
          'access-control-allow-methods': `${routeMethod}, OPTIONS`,
          'access-control-max-age': '600',
          'cache-control': 'no-store'
        });
        response.end();
        return true;
      }

      if (request.method !== routeMethod) {
        methodNotAllowed(response, routeMethod, headers);
        return true;
      }

      if (pathname === '/auth/google/start') {
        response.writeHead(302, {
          ...headers,
          'cache-control': 'no-store',
          location: auth.startGoogleLogin()
        });
        response.end();
        return true;
      }

      if (pathname === '/auth/google/callback') {
        if (requestUrl.searchParams.has('error'))
          throw new HttpError(400, 'google_login_cancelled', 'Google login was cancelled or denied.');
        const session = await auth.finishGoogleLogin({
          code: requestUrl.searchParams.get('code'),
          state: requestUrl.searchParams.get('state')
        });
        response.writeHead(303, {
          'cache-control': 'no-store',
          location: auth.appRedirect(session),
          'referrer-policy': 'no-referrer'
        });
        response.end();
        return true;
      }

      if (pathname === '/auth/me') {
        const account = auth.authenticate(request.headers, true);
        sendJson(response, 200, {
          userId: account.userId,
          email: account.email,
          displayName: account.displayName,
          entitlements: account.entitlements
        }, headers);
        return true;
      }

      if (pathname === '/auth/logout') {
        auth.revokePresentedSession(request.headers);
        sendJson(response, 200, { ok: true }, headers);
        return true;
      }

      if (pathname === '/shop/catalog') {
        const account = auth.authenticate(request.headers, false);
        sendJson(response, 200, {
          items: await shop.catalog(account && account.userId)
        }, headers);
        return true;
      }

      if (pathname === '/shop/checkout') {
        const account = auth.authenticate(request.headers, true);
        const body = await readJsonBody(request);
        const result = await shop.checkout(account.userId, body.cosmeticId);
        sendJson(response, 200, result, headers);
        return true;
      }

      if (pathname === '/stripe/webhook') {
        const rawBody = await readRequestBody(request);
        const result = await shop.webhook(
          rawBody,
          headerValue(request.headers, 'stripe-signature')
        );
        sendJson(response, 200, {
          received: true,
          duplicate: result.duplicate
        });
        return true;
      }
    } catch (error) {
      if (error instanceof HttpError) {
        sendJson(response, error.status, {
          error: error.code,
          message: error.message
        }, headers);
        return true;
      }
      console.error(`Account/store request failed: ${error && error.stack || error}`);
      sendJson(response, 500, {
        error: 'internal_error',
        message: 'Internal server error.'
      }, headers);
      return true;
    }
    return true;
  }

  function close() {
    if (closed) return;
    closed = true;
    if (ownsDatabase) db.close();
  }

  return { db, auth, shop, handleHttp, close };
}

export function createAccountStoreFromEnvironment(env, options = {}) {
  requiredEnvironment(env, [
    'GOOGLE_CLIENT_ID',
    'GOOGLE_CLIENT_SECRET',
    'GOOGLE_REDIRECT_URI',
    'GAME_ORIGIN',
    'STRIPE_SECRET_KEY',
    'STRIPE_WEBHOOK_SECRET'
  ]);
  const priceIds = Object.fromEntries(COSMETICS.map((cosmetic) => [
    cosmetic.id,
    typeof env[cosmetic.priceEnvVar] === 'string'
      ? env[cosmetic.priceEnvVar].trim()
      : ''
  ]));
  return createAccountStore({
    dbPath: storePathFromEnvironment(env),
    allowedOrigins: (env.ALLOWED_ORIGINS || '').split(','),
    googleClientId: env.GOOGLE_CLIENT_ID,
    googleClientSecret: env.GOOGLE_CLIENT_SECRET,
    googleRedirectUri: env.GOOGLE_REDIRECT_URI,
    appOrigin: env.GAME_ORIGIN,
    stripeSecretKey: env.STRIPE_SECRET_KEY,
    stripeWebhookSecret: env.STRIPE_WEBHOOK_SECRET,
    priceIds,
    ...options
  });
}
