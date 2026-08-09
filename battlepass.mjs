import { randomUUID } from 'node:crypto';

import { PREMIUM_PASS_ID } from './cosmetics.mjs';
import {
  SEASON_1,
  SEASON_1_ID,
  SEASON_1_MATCH_XP,
  SEASON_1_TIERS,
  season1Status,
  tierForXp,
  xpToNextTier
} from './season1.mjs';

const REWARD_TIERS = new Map(SEASON_1_TIERS.flatMap((entry) => [
  [`free\0${entry.freeReward}`, entry.tier],
  [`premium\0${entry.premiumReward}`, entry.tier]
]));

/* These are battle-pass balance values, not physics constants. They define
   what the relay must actually observe before one fixed match award is earned. */
export const BATTLE_PASS_MIN_MATCH_DURATION_MS = 90_000;
/* XP belongs to each authenticated account that played the round from its
   opening whistle to its result. The rest of the lobby may be anonymous, and
   bots may fill every other combatant slot, so one account is enough to make
   a completed multiplayer match awardable. */
export const BATTLE_PASS_MIN_PARTICIPANTS = 1;
export const BATTLE_PASS_MIN_SNAPSHOTS = 10;
export const BATTLE_PASS_MAX_AWARDS_PER_WINDOW = 20;
export const BATTLE_PASS_AWARD_WINDOW_MS = 24 * 60 * 60 * 1000;
export const BATTLE_PASS_RETRY_BASE_MS = 1_000;
export const BATTLE_PASS_MAX_RETRY_DELAY_MS = 60_000;
export const BATTLE_PASS_MAX_RETRY_ATTEMPTS = 5;
export const BATTLE_PASS_PENDING_SCAN_LIMIT = 100;

export function createBattlePassService(options = {}) {
  if (!options.db) throw new Error('The battle pass needs an account database.');
  const db = options.db;
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const retryNow = typeof options.retryNow === 'function'
    ? options.retryNow
    : Date.now;
  const makeRevocationId = typeof options.revocationIdFactory === 'function'
    ? options.revocationIdFactory
    : randomUUID;

  function earnedRewards(tier, premium) {
    const rewards = [];
    for (const entry of SEASON_1_TIERS) {
      if (entry.tier > tier) break;
      rewards.push({
        tier: entry.tier,
        lane: 'free',
        rewardId: entry.freeReward
      });
      if (premium) {
        rewards.push({
          tier: entry.tier,
          lane: 'premium',
          rewardId: entry.premiumReward
        });
      }
    }
    return rewards;
  }

  function unlockEarned(userId, xp, claimedAt = now()) {
    const premium = db.hasEntitlement(userId, PREMIUM_PASS_ID);
    const rewards = earnedRewards(tierForXp(xp), premium);
    return rewards.length
      ? db.claimBattlePassRewards({
        userId,
        seasonId: SEASON_1_ID,
        rewards,
        claimedAt
      })
      : [];
  }

  function progressFor(userId) {
    const progress = db.getBattlePassProgress(userId, SEASON_1_ID);
    const claimedRewards = progress.claimedRewards.map((reward) => {
      const tier = REWARD_TIERS.get(`${reward.lane}\0${reward.rewardId}`);
      return { tier: tier === undefined ? null : tier, ...reward };
    }).sort((left, right) => {
      const leftTier = left.tier === null ? Number.POSITIVE_INFINITY : left.tier;
      const rightTier = right.tier === null ? Number.POSITIVE_INFINITY : right.tier;
      return leftTier - rightTier ||
        (left.lane === right.lane ? 0 : (left.lane === 'free' ? -1 : 1));
    });
    return { xp: progress.xp, claimedRewards };
  }

  function me(userId) {
    const progress = progressFor(userId);
    const tier = tierForXp(progress.xp);
    return {
      seasonId: SEASON_1.id,
      startsAt: SEASON_1.startsAt,
      endsAt: SEASON_1.endsAt,
      status: season1Status(now()),
      xp: progress.xp,
      tier,
      xpToNextTier: xpToNextTier(progress.xp),
      premium: db.hasEntitlement(userId, PREMIUM_PASS_ID),
      claimedRewards: progress.claimedRewards
    };
  }

  function claimedRewardIds(userId) {
    return db.listClaimedBattlePassRewards(userId);
  }

  /* A match result contains identity and relay-observed evidence, never
     progress. This boundary enforces the evidence floors before supplying the
     one fixed award and deriving every consequence from the frozen curve. */
  function awardMatchAt(matchId, userIds, evidence, awardedAt) {
    if (typeof matchId !== 'string' || !matchId)
      throw new Error('A battle-pass award needs a relay match id.');
    const participants = Array.from(new Set(
      Array.isArray(userIds) ? userIds.filter((id) => typeof id === 'string' && id) : []
    ));
    const status = season1Status(awardedAt);
    if (status !== 'active') {
      return {
        matchId,
        status,
        xpPerAccount: 0,
        accounts: participants.map((userId) => ({ userId, awarded: false }))
      };
    }
    const sufficientEvidence = evidence &&
      Number.isFinite(evidence.durationMs) &&
      evidence.durationMs >= BATTLE_PASS_MIN_MATCH_DURATION_MS &&
      Number.isSafeInteger(evidence.participantCount) &&
      evidence.participantCount === participants.length &&
      evidence.participantCount >= BATTLE_PASS_MIN_PARTICIPANTS &&
      Number.isSafeInteger(evidence.snapshotCount) &&
      evidence.snapshotCount >= BATTLE_PASS_MIN_SNAPSHOTS;
    if (!sufficientEvidence) {
      return {
        matchId,
        status,
        xpPerAccount: 0,
        accounts: participants.map((userId) => ({ userId, awarded: false }))
      };
    }

    /* Every participant mutation shares one SQLite transaction. If applying
       any account fails, no receipt, XP, or reward from this result commits. */
    const results = db.awardBattlePassMatch({
      userIds: participants,
      seasonId: SEASON_1_ID,
      matchId,
      xp: SEASON_1_MATCH_XP,
      awardedAt,
      maxAwards: BATTLE_PASS_MAX_AWARDS_PER_WINDOW,
      awardWindowMs: BATTLE_PASS_AWARD_WINDOW_MS,
      apply: ({ userId, xp }) => unlockEarned(userId, xp, awardedAt)
    });
    const accounts = results.map((result) => ({
      userId: result.userId,
      awarded: !result.duplicate && !result.capped,
      capped: result.capped,
      xp: result.xp,
      tier: tierForXp(result.xp),
      unlockedRewards: result.unlockedRewards
    }));
    return { matchId, status, xpPerAccount: SEASON_1_MATCH_XP, accounts };
  }

  function awardMatch(matchId, userIds, evidence) {
    return awardMatchAt(matchId, userIds, evidence, now());
  }

  function retryPendingMatches(options = {}) {
    const retryBaseMs = Number.isSafeInteger(options.retryBaseMs) &&
      options.retryBaseMs > 0
      ? options.retryBaseMs
      : BATTLE_PASS_RETRY_BASE_MS;
    const maxAttempts = Number.isSafeInteger(options.maxAttempts) &&
      options.maxAttempts > 0
      ? options.maxAttempts
      : BATTLE_PASS_MAX_RETRY_ATTEMPTS;
    const attemptedAt = retryNow();
    const awarded = [];
    const failures = [];
    const deadLetters = [];
    let nextRetryAt = null;
    for (const pending of db.pendingBattlePassMatches(
      attemptedAt,
      BATTLE_PASS_PENDING_SCAN_LIMIT
    )) {
      try {
        if (pending.parseError) throw pending.parseError;
        const result = awardMatchAt(
          pending.matchId,
          pending.userIds,
          pending.evidence,
          pending.awardedAt
        );
        db.deletePendingBattlePassMatch(pending.matchId);
        awarded.push(result);
      } catch (error) {
        const delay = Math.min(
          BATTLE_PASS_MAX_RETRY_DELAY_MS,
          retryBaseMs * (2 ** pending.attemptCount)
        );
        const failure = db.failPendingBattlePassMatch({
          matchId: pending.matchId,
          failedAt: attemptedAt,
          nextAttemptAt: attemptedAt + delay,
          maxAttempts,
          error
        });
        if (!failure) continue;
        const report = { matchId: pending.matchId, error, ...failure };
        if (failure.retryState === 'operator') {
          deadLetters.push(report);
        } else {
          failures.push(report);
          nextRetryAt = nextRetryAt === null
            ? failure.nextAttemptAt
            : Math.min(nextRetryAt, failure.nextAttemptAt);
        }
      }
    }
    const nextPendingAt = db.nextPendingBattlePassAttemptAt();
    if (nextPendingAt !== null) {
      nextRetryAt = nextRetryAt === null
        ? nextPendingAt
        : Math.min(nextRetryAt, nextPendingAt);
    }
    return { awarded, failures, deadLetters, nextRetryAt };
  }

  /* Persist the relay-authored result before attempting account mutations. A
     failed award remains durable across both later rounds and relay restarts;
     success deletes it, while exhausting bounded retries keeps it for an
     operator outside the active queue. */
  function recordMatchResult(
    matchId,
    userIds,
    evidence,
    awardedAt = now(),
    retryOptions = {}
  ) {
    db.recordPendingBattlePassMatch({
      matchId,
      userIds,
      evidence,
      awardedAt
    });
    return retryPendingMatches(retryOptions);
  }

  /* Checkout's webhook calls this inside the same receipt transaction. That
     is what makes a late premium purchase open the already-earned lane without
     inventing a second payment path or a client-authored unlock request. */
  function entitlementGranted(userId, productId, grantedAt = now()) {
    if (productId !== PREMIUM_PASS_ID) return [];
    const progress = progressFor(userId);
    return unlockEarned(userId, progress.xp, grantedAt)
      .filter((reward) => reward.lane === 'premium');
  }

  function entitlementRevoked(
    userId,
    productId,
    revokedAt = now(),
    revocationId
  ) {
    if (productId !== PREMIUM_PASS_ID) return [];
    const candidateRevocationId = typeof revocationId === 'string' && revocationId
      ? revocationId
      : makeRevocationId();
    if (typeof candidateRevocationId !== 'string' || !candidateRevocationId)
      throw new Error('Revoking premium rewards needs a unique revocation id.');
    const exactRevocationId = candidateRevocationId;
    return db.revokeBattlePassPremiumRewards({
      userId,
      seasonId: SEASON_1_ID,
      revocationId: exactRevocationId,
      revokedAt
    }).map((reward) => ({
      tier: REWARD_TIERS.get(`${reward.lane}\0${reward.rewardId}`) ?? null,
      revocationId: exactRevocationId,
      ...reward
    }));
  }

  function entitlementRestored(
    userId,
    productId,
    restoredAt = now(),
    revocationId = null
  ) {
    if (productId !== PREMIUM_PASS_ID ||
        !db.hasEntitlement(userId, PREMIUM_PASS_ID)) return [];
    const restored = db.restoreBattlePassPremiumRewards({
      userId,
      seasonId: SEASON_1_ID,
      revocationId
    }).map((reward) => ({
      tier: REWARD_TIERS.get(`${reward.lane}\0${reward.rewardId}`) ?? null,
      ...reward
    }));
    /* A restore is current ownership again, not merely an undo of rows that
       existed at the refund. Unlock the premium lane at the account's current
       XP so tiers earned while the pass was revoked are included even when the
       season has already ended and no later match can trigger another unlock. */
    const progress = progressFor(userId);
    const newlyUnlocked = unlockEarned(userId, progress.xp, restoredAt)
      .filter((reward) => reward.lane === 'premium');
    const byReward = new Map();
    for (const reward of [...restored, ...newlyUnlocked])
      byReward.set(reward.rewardId, reward);
    return Array.from(byReward.values());
  }

  return {
    me,
    claimedRewardIds,
    awardMatch,
    recordMatchResult,
    retryPendingMatches,
    entitlementGranted,
    entitlementRevoked,
    entitlementRestored
  };
}
