import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

function rowToUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    googleSubject: row.google_subject,
    email: row.email,
    displayName: row.display_name
  };
}

export function openStoreDatabase(path, options = {}) {
  if (typeof path !== 'string' || !path)
    throw new Error('The account database needs a non-empty path.');

  const makeId = typeof options.idFactory === 'function'
    ? options.idFactory
    : randomUUID;
  const database = new DatabaseSync(path);

  /* WAL lets a profile read finish while a webhook is recording a purchase.
     This is still one small process on one droplet, but Stripe retries and page
     loads are independent clocks; making either wait for the other buys no
     correctness. The busy timeout covers the brief hand-off between writers
     without turning a momentary lock into a failed payment notification. */
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      google_subject TEXT NOT NULL UNIQUE,
      email TEXT NOT NULL,
      display_name TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      revoked_at INTEGER
    ) STRICT;

    CREATE INDEX IF NOT EXISTS sessions_by_user
      ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS live_sessions_by_expiry
      ON sessions(expires_at) WHERE revoked_at IS NULL;

    CREATE TABLE IF NOT EXISTS entitlements (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      cosmetic_id TEXT NOT NULL,
      checkout_session_id TEXT,
      payment_intent_id TEXT,
      granted_at INTEGER NOT NULL,
      revoked_at INTEGER,
      PRIMARY KEY (user_id, cosmetic_id)
    ) STRICT;

    CREATE INDEX IF NOT EXISTS entitlements_by_payment_intent
      ON entitlements(payment_intent_id);
    CREATE INDEX IF NOT EXISTS entitlements_by_checkout_session
      ON entitlements(checkout_session_id);

    CREATE TABLE IF NOT EXISTS processed_webhook_events (
      event_id TEXT PRIMARY KEY,
      event_type TEXT NOT NULL,
      processed_at INTEGER NOT NULL
    ) STRICT;
  `);

  const statements = {
    upsertGoogleUser: database.prepare(`
      INSERT INTO users (
        id, google_subject, email, display_name, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(google_subject) DO UPDATE SET
        email = excluded.email,
        display_name = excluded.display_name,
        updated_at = excluded.updated_at
      RETURNING id, google_subject, email, display_name
    `),
    getUser: database.prepare(`
      SELECT id, google_subject, email, display_name
      FROM users
      WHERE id = ?
    `),
    insertSession: database.prepare(`
      INSERT INTO sessions (token_hash, user_id, created_at, expires_at)
      VALUES (?, ?, ?, ?)
    `),
    pruneSessions: database.prepare(`
      DELETE FROM sessions
      WHERE expires_at <= ?
    `),
    sessionUser: database.prepare(`
      SELECT
        users.id,
        users.google_subject,
        users.email,
        users.display_name,
        sessions.expires_at
      FROM sessions
      JOIN users ON users.id = sessions.user_id
      WHERE sessions.token_hash = ?
        AND sessions.revoked_at IS NULL
        AND sessions.expires_at > ?
    `),
    revokeSession: database.prepare(`
      UPDATE sessions
      SET revoked_at = ?
      WHERE token_hash = ? AND revoked_at IS NULL
    `),
    activeEntitlements: database.prepare(`
      SELECT cosmetic_id
      FROM entitlements
      WHERE user_id = ? AND revoked_at IS NULL
      ORDER BY cosmetic_id
    `),
    hasEntitlement: database.prepare(`
      SELECT 1 AS owned
      FROM entitlements
      WHERE user_id = ? AND cosmetic_id = ? AND revoked_at IS NULL
    `),
    entitlementGrantVersion: database.prepare(`
      SELECT granted_at
      FROM entitlements
      WHERE user_id = ? AND cosmetic_id = ?
    `),
    grantEntitlement: database.prepare(`
      INSERT INTO entitlements (
        user_id, cosmetic_id, checkout_session_id, payment_intent_id,
        granted_at, revoked_at
      ) VALUES (?, ?, ?, ?, ?, NULL)
      ON CONFLICT(user_id, cosmetic_id) DO UPDATE SET
        checkout_session_id = excluded.checkout_session_id,
        payment_intent_id = excluded.payment_intent_id,
        granted_at = excluded.granted_at,
        revoked_at = NULL
    `),
    recordWebhook: database.prepare(`
      INSERT OR IGNORE INTO processed_webhook_events (
        event_id, event_type, processed_at
      ) VALUES (?, ?, ?)
    `),
    processedWebhookCount: database.prepare(`
      SELECT COUNT(*) AS count FROM processed_webhook_events
    `)
  };

  function upsertGoogleUser({ subject, email, displayName }, now = Date.now()) {
    if (!subject || !email || !displayName)
      throw new Error('A Google user needs a subject, email, and display name.');
    const row = statements.upsertGoogleUser.get(
      String(makeId()),
      String(subject),
      String(email),
      String(displayName),
      now,
      now
    );
    return rowToUser(row);
  }

  function getUser(userId) {
    return rowToUser(statements.getUser.get(userId));
  }

  function createSession({ tokenHash, userId, createdAt, expiresAt }) {
    /* Login is the natural maintenance point: it is already a write, happens
       regularly on an active service, and lets expired and revoked credentials
       disappear without adding a timer whose only job is database housekeeping. */
    statements.pruneSessions.run(createdAt);
    statements.insertSession.run(tokenHash, userId, createdAt, expiresAt);
  }

  function findSessionUser(tokenHash, now = Date.now()) {
    const row = statements.sessionUser.get(tokenHash, now);
    if (!row) return null;
    return {
      ...rowToUser(row),
      sessionExpiresAt: row.expires_at
    };
  }

  function revokeSession(tokenHash, now = Date.now()) {
    return statements.revokeSession.run(now, tokenHash).changes > 0;
  }

  function listEntitlements(userId) {
    return statements.activeEntitlements.all(userId)
      .map((row) => row.cosmetic_id);
  }

  function hasEntitlement(userId, cosmeticId) {
    return !!statements.hasEntitlement.get(userId, cosmeticId);
  }

  function entitlementGrantVersion(userId, cosmeticId) {
    const row = statements.entitlementGrantVersion.get(userId, cosmeticId);
    return row ? row.granted_at : null;
  }

  function grantEntitlement({
    userId,
    cosmeticId,
    checkoutSessionId = null,
    paymentIntentId = null,
    grantedAt = Date.now()
  }) {
    statements.grantEntitlement.run(
      userId,
      cosmeticId,
      checkoutSessionId,
      paymentIntentId,
      grantedAt
    );
  }

  /* Which row a Stripe money event is talking about. Revoking and restoring
     have to agree on this exactly — a won dispute that gave the item back to a
     different purchase than the chargeback took it from would be worse than
     doing nothing — so the matching is written once and both directions of
     `revoked_at` are prepared from it. */
  const PURCHASE_MATCHES = {
    paymentIntent: 'payment_intent_id = ?',
    checkoutSession: 'checkout_session_id = ?',
    /* Metadata cannot identify which purchase it came from. It is safe only
       for a legacy row that has no Stripe purchase identifier of its own;
       otherwise a late event for an older purchase could reach a newer
       repurchase that now occupies the same user/item row. */
    metadata: `user_id = ? AND cosmetic_id = ?
        AND payment_intent_id IS NULL
        AND checkout_session_id IS NULL`
  };

  function purchaseStatements(assignment, eligible) {
    const prepared = {};
    for (const [name, match] of Object.entries(PURCHASE_MATCHES)) {
      prepared[name] = database.prepare(`
        UPDATE entitlements
        SET ${assignment}
        WHERE ${eligible} AND (${match})
      `);
    }
    return prepared;
  }

  const revokeStatements = purchaseStatements('revoked_at = ?', 'revoked_at IS NULL');
  const restoreStatements = purchaseStatements('revoked_at = NULL', 'revoked_at IS NOT NULL');

  /* Prefer Stripe's purchase identifiers whenever one is present; exactly one
     of the three ever applies. */
  function purchaseSelector({ paymentIntentId, checkoutSessionId, userId, cosmeticId }) {
    if (paymentIntentId) return { match: 'paymentIntent', values: [paymentIntentId] };
    if (checkoutSessionId) return { match: 'checkoutSession', values: [checkoutSessionId] };
    if (userId && cosmeticId) return { match: 'metadata', values: [userId, cosmeticId] };
    return null;
  }

  function revokePurchase({
    paymentIntentId = null,
    checkoutSessionId = null,
    userId = null,
    cosmeticId = null,
    revokedAt = Date.now()
  }) {
    const selector = purchaseSelector({
      paymentIntentId, checkoutSessionId, userId, cosmeticId
    });
    if (!selector) return 0;
    return Number(
      revokeStatements[selector.match].run(revokedAt, ...selector.values).changes
    );
  }

  /* The undo of a revocation, for the one case that has one: a dispute the
     merchant won. Only a row that is currently revoked can come back, so this
     cannot mint an entitlement nobody was ever granted. It leaves `granted_at`
     alone deliberately — the purchase generation has not changed, and the
     checkout idempotency key is derived from it. */
  function restorePurchase({
    paymentIntentId = null,
    checkoutSessionId = null,
    userId = null,
    cosmeticId = null
  }) {
    const selector = purchaseSelector({
      paymentIntentId, checkoutSessionId, userId, cosmeticId
    });
    if (!selector) return 0;
    return Number(restoreStatements[selector.match].run(...selector.values).changes);
  }

  /* Stripe promises at-least-once delivery, not exactly-once delivery. The
     receipt and the entitlement therefore share one SQLite transaction: a
     crash cannot leave behind a receipt for work that never happened, and a
     retry cannot repeat work whose receipt committed. The callback is kept
     synchronous on purpose so no network wait can hold this write lock. */
  function processWebhookEvent(eventId, eventType, processedAt, apply) {
    database.exec('BEGIN IMMEDIATE');
    try {
      const recorded = statements.recordWebhook.run(
        eventId,
        eventType,
        processedAt
      ).changes > 0;
      if (!recorded) {
        database.exec('COMMIT');
        return { duplicate: true, result: null };
      }
      const result = apply();
      database.exec('COMMIT');
      return { duplicate: false, result };
    } catch (error) {
      /* Rolling back must not replace the reason for rolling back. SQLite may
         have aborted the transaction itself already, in which case an explicit
         ROLLBACK throws "cannot rollback - no transaction is active" on top of
         the failure worth reading. */
      try {
        database.exec('ROLLBACK');
      } catch (rollbackError) {}
      throw error;
    }
  }

  function countProcessedWebhookEvents() {
    return Number(statements.processedWebhookCount.get().count);
  }

  return {
    database,
    upsertGoogleUser,
    getUser,
    createSession,
    findSessionUser,
    revokeSession,
    listEntitlements,
    hasEntitlement,
    entitlementGrantVersion,
    grantEntitlement,
    revokePurchase,
    restorePurchase,
    processWebhookEvent,
    countProcessedWebhookEvents,
    close: () => database.close()
  };
}
