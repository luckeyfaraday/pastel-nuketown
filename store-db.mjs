import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

import { SEASON_1_TIERS } from './season1.mjs';

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
  const makeRevocationId = typeof options.revocationIdFactory === 'function'
    ? options.revocationIdFactory
    : randomUUID;
  const logger = options.logger || console;
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
      revocation_id TEXT,
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

    CREATE TABLE IF NOT EXISTS battlepass_progress (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      season_id TEXT NOT NULL,
      xp INTEGER NOT NULL DEFAULT 0 CHECK (xp >= 0),
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, season_id)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS battlepass_claimed_rewards (
      user_id TEXT NOT NULL,
      season_id TEXT NOT NULL,
      lane TEXT NOT NULL CHECK (lane IN ('free', 'premium')),
      reward_id TEXT NOT NULL,
      claimed_at INTEGER NOT NULL,
      revoked_at INTEGER,
      revocation_id TEXT,
      PRIMARY KEY (user_id, season_id, lane, reward_id),
      FOREIGN KEY (user_id, season_id)
        REFERENCES battlepass_progress(user_id, season_id) ON DELETE CASCADE
    ) STRICT;

    CREATE TABLE IF NOT EXISTS battlepass_match_awards (
      match_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      season_id TEXT NOT NULL,
      xp INTEGER NOT NULL CHECK (xp > 0),
      awarded_at INTEGER NOT NULL,
      PRIMARY KEY (match_id, user_id, season_id),
      FOREIGN KEY (user_id, season_id)
        REFERENCES battlepass_progress(user_id, season_id) ON DELETE CASCADE
    ) STRICT;

    CREATE INDEX IF NOT EXISTS battlepass_awards_by_account_time
      ON battlepass_match_awards(user_id, season_id, awarded_at);

    CREATE TABLE IF NOT EXISTS battlepass_pending_matches (
      match_id TEXT PRIMARY KEY,
      user_ids_json TEXT NOT NULL,
      duration_ms INTEGER NOT NULL CHECK (duration_ms >= 0),
      participant_count INTEGER NOT NULL CHECK (participant_count >= 0),
      snapshot_count INTEGER NOT NULL CHECK (snapshot_count >= 0),
      awarded_at INTEGER NOT NULL,
      attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
      next_attempt_at INTEGER NOT NULL DEFAULT 0,
      retry_state TEXT NOT NULL DEFAULT 'pending'
        CHECK (retry_state IN ('pending', 'operator')),
      last_error TEXT,
      operator_at INTEGER
    ) STRICT;

    CREATE TABLE IF NOT EXISTS schema_migrations (
      migration_id TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL
    ) STRICT;
  `);

  /* The first battle-pass build had neither reversible claims nor an exact
     revocation marker. Keep existing account databases upgradeable in place;
     fresh databases already have these columns from the CREATE TABLE above. */
  const claimedRewardColumns = database.prepare(
    'PRAGMA table_info(battlepass_claimed_rewards)'
  ).all();
  if (!claimedRewardColumns.some((column) => column.name === 'revoked_at')) {
    database.exec(
      'ALTER TABLE battlepass_claimed_rewards ADD COLUMN revoked_at INTEGER'
    );
  }
  if (!claimedRewardColumns.some((column) => column.name === 'revocation_id')) {
    database.exec(
      'ALTER TABLE battlepass_claimed_rewards ADD COLUMN revocation_id TEXT'
    );
  }

  const entitlementColumns = database.prepare(
    'PRAGMA table_info(entitlements)'
  ).all();
  if (!entitlementColumns.some((column) => column.name === 'revocation_id')) {
    database.exec('ALTER TABLE entitlements ADD COLUMN revocation_id TEXT');
  }

  /* Retry state was added after pending match durability. Existing rows remain
     immediately eligible with zero attempts, while terminal rows survive a
     restart for an operator to inspect instead of re-entering the hot queue. */
  const pendingMatchColumns = database.prepare(
    'PRAGMA table_info(battlepass_pending_matches)'
  ).all();
  if (!pendingMatchColumns.some((column) => column.name === 'attempt_count')) {
    database.exec(`
      ALTER TABLE battlepass_pending_matches
      ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0)
    `);
  }
  if (!pendingMatchColumns.some((column) => column.name === 'next_attempt_at')) {
    database.exec(`
      ALTER TABLE battlepass_pending_matches
      ADD COLUMN next_attempt_at INTEGER NOT NULL DEFAULT 0
    `);
  }
  if (!pendingMatchColumns.some((column) => column.name === 'retry_state')) {
    database.exec(`
      ALTER TABLE battlepass_pending_matches
      ADD COLUMN retry_state TEXT NOT NULL DEFAULT 'pending'
        CHECK (retry_state IN ('pending', 'operator'))
    `);
  }
  if (!pendingMatchColumns.some((column) => column.name === 'last_error')) {
    database.exec('ALTER TABLE battlepass_pending_matches ADD COLUMN last_error TEXT');
  }
  if (!pendingMatchColumns.some((column) => column.name === 'operator_at')) {
    database.exec('ALTER TABLE battlepass_pending_matches ADD COLUMN operator_at INTEGER');
  }
  database.exec(`
    CREATE INDEX IF NOT EXISTS battlepass_pending_due
      ON battlepass_pending_matches(next_attempt_at, awarded_at, match_id)
      WHERE retry_state = 'pending'
  `);

  const earnedEntitlementsMigration = 'season-1-earned-entitlements-cleanup';
  const migrationApplied = database.prepare(`
    SELECT 1 AS applied
    FROM schema_migrations
    WHERE migration_id = ?
  `);
  if (!migrationApplied.get(earnedEntitlementsMigration)) {
    /* This removes rows created by the original earned-reward path once. Future
       identifier-less grants are intentional account inventory and must survive
       ordinary database reopens. The marker and cleanup commit together. */
    const season1RewardIds = SEASON_1_TIERS.flatMap((tier) => [
      tier.freeReward,
      tier.premiumReward
    ]);
    database.exec('BEGIN IMMEDIATE');
    let removed = 0;
    try {
      if (!migrationApplied.get(earnedEntitlementsMigration)) {
        removed = database.prepare(`
          DELETE FROM entitlements
          WHERE payment_intent_id IS NULL
            AND checkout_session_id IS NULL
            AND cosmetic_id IN (${season1RewardIds.map(() => '?').join(', ')})
        `).run(...season1RewardIds).changes;
        database.prepare(`
          INSERT INTO schema_migrations (migration_id, applied_at)
          VALUES (?, ?)
        `).run(earnedEntitlementsMigration, Date.now());
      }
      database.exec('COMMIT');
    } catch (error) {
      try {
        database.exec('ROLLBACK');
      } catch (rollbackError) {}
      throw error;
    }
    if (removed > 0 && logger && typeof logger.info === 'function') {
      logger.info(
        `Season 1 entitlement migration removed ${removed} legacy earned ` +
        `${removed === 1 ? 'row' : 'rows'}.`
      );
    }
  }

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
        granted_at, revoked_at, revocation_id
      ) VALUES (?, ?, ?, ?, ?, NULL, NULL)
      ON CONFLICT(user_id, cosmetic_id) DO UPDATE SET
        checkout_session_id = excluded.checkout_session_id,
        payment_intent_id = excluded.payment_intent_id,
        granted_at = excluded.granted_at,
        revoked_at = NULL,
        revocation_id = NULL
    `),
    recordWebhook: database.prepare(`
      INSERT OR IGNORE INTO processed_webhook_events (
        event_id, event_type, processed_at
      ) VALUES (?, ?, ?)
    `),
    processedWebhookCount: database.prepare(`
      SELECT COUNT(*) AS count FROM processed_webhook_events
    `),
    battlePassProgress: database.prepare(`
      SELECT xp
      FROM battlepass_progress
      WHERE user_id = ? AND season_id = ?
    `),
    createBattlePassProgress: database.prepare(`
      INSERT OR IGNORE INTO battlepass_progress (
        user_id, season_id, xp, updated_at
      ) VALUES (?, ?, 0, ?)
    `),
    updateBattlePassXp: database.prepare(`
      UPDATE battlepass_progress
      SET xp = xp + ?, updated_at = ?
      WHERE user_id = ? AND season_id = ?
    `),
    battlePassClaims: database.prepare(`
      SELECT lane, reward_id, claimed_at
      FROM battlepass_claimed_rewards
      WHERE user_id = ? AND season_id = ?
        AND revoked_at IS NULL
      ORDER BY claimed_at, CASE lane WHEN 'free' THEN 0 ELSE 1 END, reward_id
    `),
    activeBattlePassClaimIds: database.prepare(`
      SELECT reward_id
      FROM battlepass_claimed_rewards
      WHERE user_id = ? AND revoked_at IS NULL
      ORDER BY reward_id
    `),
    claimBattlePassReward: database.prepare(`
      INSERT OR IGNORE INTO battlepass_claimed_rewards (
        user_id, season_id, lane, reward_id, claimed_at, revoked_at,
        revocation_id
      ) VALUES (?, ?, ?, ?, ?, NULL, NULL)
      ON CONFLICT(user_id, season_id, lane, reward_id) DO UPDATE SET
        revoked_at = NULL,
        revocation_id = NULL
      WHERE battlepass_claimed_rewards.revoked_at IS NOT NULL
    `),
    revokeBattlePassPremiumRewards: database.prepare(`
      UPDATE battlepass_claimed_rewards
      SET revoked_at = ?, revocation_id = ?
      WHERE user_id = ? AND season_id = ? AND lane = 'premium'
        AND revoked_at IS NULL
      RETURNING lane, reward_id, claimed_at
    `),
    restoreBattlePassPremiumRewards: database.prepare(`
      UPDATE battlepass_claimed_rewards
      SET revoked_at = NULL, revocation_id = NULL
      WHERE user_id = ? AND season_id = ? AND lane = 'premium'
        AND revoked_at IS NOT NULL AND revocation_id = ?
      RETURNING lane, reward_id, claimed_at
    `),
    restoreLegacyBattlePassPremiumRewards: database.prepare(`
      UPDATE battlepass_claimed_rewards
      SET revoked_at = NULL, revocation_id = NULL
      WHERE user_id = ? AND season_id = ? AND lane = 'premium'
        AND revoked_at IS NOT NULL AND revocation_id IS NULL
      RETURNING lane, reward_id, claimed_at
    `),
    recordBattlePassMatch: database.prepare(`
      INSERT OR IGNORE INTO battlepass_match_awards (
        match_id, user_id, season_id, xp, awarded_at
      ) VALUES (?, ?, ?, ?, ?)
    `),
    battlePassMatchAward: database.prepare(`
      SELECT xp
      FROM battlepass_match_awards
      WHERE match_id = ? AND user_id = ? AND season_id = ?
    `),
    recentBattlePassAwards: database.prepare(`
      SELECT COUNT(*) AS count
      FROM battlepass_match_awards
      WHERE user_id = ? AND season_id = ? AND awarded_at > ?
    `),
    recordPendingBattlePassMatch: database.prepare(`
      INSERT OR IGNORE INTO battlepass_pending_matches (
        match_id, user_ids_json, duration_ms, participant_count,
        snapshot_count, awarded_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `),
    pendingBattlePassMatches: database.prepare(`
      SELECT
        match_id, user_ids_json, duration_ms, participant_count,
        snapshot_count, awarded_at, attempt_count, next_attempt_at
      FROM battlepass_pending_matches
      WHERE retry_state = 'pending' AND next_attempt_at <= ?
      ORDER BY next_attempt_at, awarded_at, match_id
      LIMIT ?
    `),
    nextPendingBattlePassAttempt: database.prepare(`
      SELECT MIN(next_attempt_at) AS next_attempt_at
      FROM battlepass_pending_matches
      WHERE retry_state = 'pending'
    `),
    failPendingBattlePassMatch: database.prepare(`
      UPDATE battlepass_pending_matches
      SET attempt_count = attempt_count + 1,
        next_attempt_at = ?,
        retry_state = CASE
          WHEN attempt_count + 1 >= ? THEN 'operator'
          ELSE 'pending'
        END,
        last_error = ?,
        operator_at = CASE
          WHEN attempt_count + 1 >= ? THEN ?
          ELSE NULL
        END
      WHERE match_id = ? AND retry_state = 'pending'
      RETURNING attempt_count, next_attempt_at, retry_state
    `),
    deletePendingBattlePassMatch: database.prepare(`
      DELETE FROM battlepass_pending_matches
      WHERE match_id = ?
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
        RETURNING user_id, cosmetic_id, revocation_id
      `);
    }
    return prepared;
  }

  const revokeStatements = purchaseStatements(
    'revoked_at = ?, revocation_id = ?',
    'revoked_at IS NULL'
  );
  const restoreStatements = purchaseStatements('revoked_at = NULL', 'revoked_at IS NOT NULL');

  let transactionDepth = 0;

  function withImmediateTransaction(apply) {
    if (transactionDepth > 0) return apply();
    database.exec('BEGIN IMMEDIATE');
    transactionDepth++;
    try {
      const result = apply();
      database.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        database.exec('ROLLBACK');
      } catch (rollbackError) {}
      throw error;
    } finally {
      transactionDepth--;
    }
  }

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
    revokedAt = Date.now(),
    apply = () => {}
  }) {
    const selector = purchaseSelector({
      paymentIntentId, checkoutSessionId, userId, cosmeticId
    });
    if (!selector) return 0;
    return withImmediateTransaction(() => {
      const revocationId = String(makeRevocationId());
      const rows = revokeStatements[selector.match].all(
        revokedAt,
        revocationId,
        ...selector.values
      );
      for (const row of rows) {
        apply({
          userId: row.user_id,
          cosmeticId: row.cosmetic_id,
          revocationId: row.revocation_id
        });
      }
      return rows.length;
    });
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
    cosmeticId = null,
    apply = () => {}
  }) {
    const selector = purchaseSelector({
      paymentIntentId, checkoutSessionId, userId, cosmeticId
    });
    if (!selector) return 0;
    return withImmediateTransaction(() => {
      const rows = restoreStatements[selector.match].all(...selector.values);
      for (const row of rows) {
        apply({
          userId: row.user_id,
          cosmeticId: row.cosmetic_id,
          revocationId: row.revocation_id
        });
      }
      return rows.length;
    });
  }

  /* Stripe promises at-least-once delivery, not exactly-once delivery. The
     receipt and the entitlement therefore share one SQLite transaction: a
     crash cannot leave behind a receipt for work that never happened, and a
     retry cannot repeat work whose receipt committed. The callback is kept
     synchronous on purpose so no network wait can hold this write lock. */
  function processWebhookEvent(eventId, eventType, processedAt, apply) {
    return withImmediateTransaction(() => {
      const recorded = statements.recordWebhook.run(
        eventId,
        eventType,
        processedAt
      ).changes > 0;
      if (!recorded) return { duplicate: true, result: null };
      const result = apply();
      return { duplicate: false, result };
    });
  }

  function countProcessedWebhookEvents() {
    return Number(statements.processedWebhookCount.get().count);
  }

  function getBattlePassProgress(userId, seasonId) {
    const progress = statements.battlePassProgress.get(userId, seasonId);
    return {
      xp: progress ? Number(progress.xp) : 0,
      claimedRewards: statements.battlePassClaims.all(userId, seasonId)
        .map((row) => ({
          lane: row.lane,
          rewardId: row.reward_id,
          claimedAt: Number(row.claimed_at)
        }))
    };
  }

  function listClaimedBattlePassRewards(userId) {
    return statements.activeBattlePassClaimIds.all(userId)
      .map((row) => row.reward_id);
  }

  /* Rewards are written from the frozen server catalog, never from a request.
     This claims table is earned inventory; `entitlements` remains exclusively
     the record of products paid for through the shop. */
  function claimBattlePassRewards({
    userId,
    seasonId,
    rewards,
    claimedAt = Date.now()
  }) {
    statements.createBattlePassProgress.run(userId, seasonId, claimedAt);
    const claimed = [];
    for (const reward of rewards) {
      const recorded = statements.claimBattlePassReward.run(
        userId,
        seasonId,
        reward.lane,
        reward.rewardId,
        claimedAt
      ).changes > 0;
      if (!recorded) continue;
      claimed.push({ ...reward, claimedAt });
    }
    return claimed;
  }

  function revokeBattlePassPremiumRewards({
    userId,
    seasonId,
    revocationId,
    revokedAt = Date.now()
  }) {
    if (typeof revocationId !== 'string' || !revocationId)
      throw new Error('Revoking battle-pass rewards needs a revocation id.');
    return statements.revokeBattlePassPremiumRewards
      .all(revokedAt, revocationId, userId, seasonId)
      .map((row) => ({
        lane: row.lane,
        rewardId: row.reward_id,
        claimedAt: Number(row.claimed_at)
      }));
  }

  function restoreBattlePassPremiumRewards({
    userId,
    seasonId,
    revocationId
  }) {
    const restore = revocationId === null
      ? statements.restoreLegacyBattlePassPremiumRewards
      : statements.restoreBattlePassPremiumRewards;
    if (revocationId !== null &&
        (typeof revocationId !== 'string' || !revocationId)) return [];
    const values = revocationId === null
      ? [userId, seasonId]
      : [userId, seasonId, revocationId];
    return restore.all(...values)
      .map((row) => ({
        lane: row.lane,
        rewardId: row.reward_id,
        claimedAt: Number(row.claimed_at)
      }));
  }

  function recordPendingBattlePassMatch({
    matchId,
    userIds,
    evidence,
    awardedAt = Date.now()
  }) {
    const participants = Array.from(new Set(
      Array.isArray(userIds)
        ? userIds.filter((userId) => typeof userId === 'string' && userId)
        : []
    ));
    if (typeof matchId !== 'string' || !matchId ||
        !evidence || !Number.isSafeInteger(evidence.durationMs) ||
        evidence.durationMs < 0 ||
        !Number.isSafeInteger(evidence.participantCount) ||
        evidence.participantCount < 0 ||
        !Number.isSafeInteger(evidence.snapshotCount) ||
        evidence.snapshotCount < 0)
      throw new Error('A pending battle-pass match needs valid relay evidence.');
    return statements.recordPendingBattlePassMatch.run(
      matchId,
      JSON.stringify(participants),
      evidence.durationMs,
      evidence.participantCount,
      evidence.snapshotCount,
      awardedAt
    ).changes > 0;
  }

  function pendingBattlePassMatches(eligibleAt = Date.now(), limit = 100) {
    if (!Number.isSafeInteger(eligibleAt) || !Number.isSafeInteger(limit) || limit <= 0)
      throw new Error('A pending battle-pass scan needs a time and positive limit.');
    return statements.pendingBattlePassMatches.all(eligibleAt, limit).map((row) => {
      let userIds;
      let parseError = null;
      try {
        userIds = JSON.parse(row.user_ids_json);
        if (!Array.isArray(userIds))
          throw new Error('Pending battle-pass participants are not an array.');
      } catch (error) {
        parseError = error;
        userIds = [];
      }
      return {
        matchId: row.match_id,
        userIds,
        parseError,
        evidence: {
          durationMs: Number(row.duration_ms),
          participantCount: Number(row.participant_count),
          snapshotCount: Number(row.snapshot_count)
        },
        awardedAt: Number(row.awarded_at),
        attemptCount: Number(row.attempt_count),
        nextAttemptAt: Number(row.next_attempt_at)
      };
    });
  }

  function nextPendingBattlePassAttemptAt() {
    const row = statements.nextPendingBattlePassAttempt.get();
    return row && Number.isSafeInteger(row.next_attempt_at)
      ? Number(row.next_attempt_at)
      : null;
  }

  function failPendingBattlePassMatch({
    matchId,
    failedAt,
    nextAttemptAt,
    maxAttempts,
    error
  }) {
    if (!Number.isSafeInteger(maxAttempts) || maxAttempts <= 0)
      throw new Error('A pending battle-pass match needs a retry limit.');
    const detail = String(error && error.stack || error).slice(0, 4000);
    const row = statements.failPendingBattlePassMatch.get(
      nextAttemptAt,
      maxAttempts,
      detail,
      maxAttempts,
      failedAt,
      matchId
    );
    return row ? {
      attemptCount: Number(row.attempt_count),
      nextAttemptAt: Number(row.next_attempt_at),
      retryState: row.retry_state
    } : null;
  }

  function deletePendingBattlePassMatch(matchId) {
    return statements.deletePendingBattlePassMatch.run(matchId).changes > 0;
  }

  /* The receipt, XP increment, and newly reached rewards are one transaction.
     A replay sees the receipt before it can touch progress; a crash cannot
     leave XP without its unlocks or unlocks without the XP that justified
     them. The callback stays synchronous so this write transaction never waits
     on asynchronous work. */
  function awardBattlePassMatch({
    userIds,
    seasonId,
    matchId,
    xp,
    awardedAt = Date.now(),
    maxAwards,
    awardWindowMs,
    apply = () => []
  }) {
    if (!Number.isSafeInteger(xp) || xp <= 0)
      throw new Error('A battle-pass match award needs positive integer XP.');
    if (!Number.isSafeInteger(maxAwards) || maxAwards <= 0 ||
        !Number.isSafeInteger(awardWindowMs) || awardWindowMs <= 0)
      throw new Error('A battle-pass match award needs a positive rolling cap.');
    const participants = Array.from(new Set(
      Array.isArray(userIds)
        ? userIds.filter((userId) => typeof userId === 'string' && userId)
        : []
    ));
    if (participants.length === 0) return [];
    return withImmediateTransaction(() => {
      const results = [];
      for (const userId of participants) {
        statements.createBattlePassProgress.run(userId, seasonId, awardedAt);
        const duplicate = statements.battlePassMatchAward.get(
          matchId,
          userId,
          seasonId
        );
        if (duplicate) {
          const current = Number(
            statements.battlePassProgress.get(userId, seasonId).xp
          );
          results.push({
            userId,
            duplicate: true,
            capped: false,
            xp: current,
            unlockedRewards: []
          });
          continue;
        }
        const recent = Number(statements.recentBattlePassAwards.get(
          userId,
          seasonId,
          awardedAt - awardWindowMs
        ).count);
        if (recent >= maxAwards) {
          const current = Number(
            statements.battlePassProgress.get(userId, seasonId).xp
          );
          results.push({
            userId,
            duplicate: false,
            capped: true,
            xp: current,
            unlockedRewards: []
          });
          continue;
        }
        const recorded = statements.recordBattlePassMatch.run(
          matchId,
          userId,
          seasonId,
          xp,
          awardedAt
        ).changes > 0;
        if (!recorded)
          throw new Error('Battle-pass match receipt changed during its transaction.');
        statements.updateBattlePassXp.run(
          xp,
          awardedAt,
          userId,
          seasonId
        );
        const current = Number(
          statements.battlePassProgress.get(userId, seasonId).xp
        );
        const unlockedRewards = apply({ userId, xp: current });
        results.push({
          userId,
          duplicate: false,
          capped: false,
          xp: current,
          unlockedRewards: Array.isArray(unlockedRewards) ? unlockedRewards : []
        });
      }
      return results;
    });
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
    getBattlePassProgress,
    listClaimedBattlePassRewards,
    claimBattlePassRewards,
    revokeBattlePassPremiumRewards,
    restoreBattlePassPremiumRewards,
    recordPendingBattlePassMatch,
    pendingBattlePassMatches,
    nextPendingBattlePassAttemptAt,
    failPendingBattlePassMatch,
    deletePendingBattlePassMatch,
    awardBattlePassMatch,
    close: () => database.close()
  };
}
