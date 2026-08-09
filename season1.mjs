import { COSMETICS_BY_ID } from './cosmetics.mjs';

/* This is a product contract, not a database seed. The dates, thresholds, and
   reward identities have to mean the same thing to a relay finishing the last
   match of the season and to a later client rendering an old account's final
   standing. Freezing the complete schedule keeps a balancing edit from
   rewriting progress that players have already earned.

   A relay-confirmed match is worth 500 XP. Three completed matches per day for
   all 30 days produce 45,000 XP, exactly the tier-25 threshold; the curve is
   deliberately stated below as product data rather than hidden in a formula. */
export const SEASON_1_ID = 'season-1';
/* Season 1 runs from the day the pass went live, so the ladder is climbable
   the moment a player can see it. The start is deliberately behind the deploy
   rather than ahead of it: a start in the future would put the pass on sale
   into a season nobody can earn in, because the window gates XP and not the
   sale. Thirty days from here keeps the three-matches-a-day curve honest. */
export const SEASON_1_START = '2026-08-09T00:00:00.000Z';
export const SEASON_1_END = '2026-09-08T00:00:00.000Z';
export const SEASON_1_MATCH_XP = 500;

export const SEASON_1_XP_CURVE = Object.freeze([
  600, 1_300, 2_100, 3_000, 4_000,
  5_100, 6_300, 7_600, 9_000, 10_500,
  12_100, 13_800, 15_600, 17_500, 19_500,
  21_600, 23_800, 26_100, 28_500, 31_000,
  33_600, 36_300, 39_100, 42_000, 45_000
]);

/* Kind tokens are only the three types the engine can draw: smg / shotgun /
   rifle (weapon skins), char (characters), fx (shot effects). The free lane
   mixes all five tokens so a climber never sits on one kind for long; the
   premium lane is denser in characters and headline weapon skins. Tier 25
   premium is the season legend character. */
const REWARDS = [
  ['s1-free-smg-first-light', 's1-premium-smg-first-light'],
  ['s1-free-fx-paper-star', 's1-premium-fx-dawn-sparks'],
  ['s1-free-char-pink-horizon', 's1-premium-char-sunrise-scout'],
  ['s1-free-shotgun-cloud-nine', 's1-premium-shotgun-peach-frost'],
  ['s1-free-fx-soft-confetti', 's1-premium-rifle-sky-ribbon'],
  ['s1-free-shotgun-tiny-teapot', 's1-premium-char-lilac-guard'],
  ['s1-free-smg-bus-stop', 's1-premium-fx-prism-pop'],
  ['s1-free-char-blue-bird', 's1-premium-smg-candy-grid'],
  ['s1-free-rifle-sunny-side', 's1-premium-shotgun-moon-mallow'],
  ['s1-free-rifle-pastel-stripe', 's1-premium-char-neon-nap'],
  ['s1-free-fx-glass-drop', 's1-premium-fx-comet-tail'],
  ['s1-free-char-nuketown-night', 's1-premium-smg-berry-static'],
  ['s1-free-fx-lucky-thirteen', 's1-premium-char-starlight-runner'],
  ['s1-free-smg-garden-wall', 's1-premium-shotgun-gilded-cloud'],
  ['s1-free-fx-paper-petals', 's1-premium-rifle-midnight-bloom'],
  ['s1-free-smg-pocket-sun', 's1-premium-char-cobalt-captain'],
  ['s1-free-shotgun-sherbet-streak', 's1-premium-fx-aurora-trail'],
  ['s1-free-rifle-tower-watch', 's1-premium-smg-prism-check'],
  ['s1-free-fx-house-party', 's1-premium-shotgun-starlight'],
  ['s1-free-char-cotton-cadet', 's1-premium-rifle-sunset-glass'],
  ['s1-free-smg-little-rocket', 's1-premium-fx-crown-burst'],
  ['s1-free-rifle-final-lap', 's1-premium-char-dream-warden'],
  ['s1-free-char-golden-ticket', 's1-premium-smg-royal-sherbet'],
  ['s1-free-shotgun-almost-there', 's1-premium-shotgun-aurora-crown'],
  ['s1-free-rifle-season-one', 's1-premium-char-season-one-legend']
];

export const SEASON_1_TIERS = Object.freeze(REWARDS.map((rewards, index) =>
  Object.freeze({
    tier: index + 1,
    xpRequired: SEASON_1_XP_CURVE[index],
    freeReward: rewards[0],
    premiumReward: rewards[1]
  })
));

export const SEASON_1 = Object.freeze({
  id: SEASON_1_ID,
  startsAt: SEASON_1_START,
  endsAt: SEASON_1_END,
  matchXp: SEASON_1_MATCH_XP,
  tiers: SEASON_1_TIERS
});

function catalogHas(catalog, id) {
  if (catalog && typeof catalog.has === 'function') return catalog.has(id);
  if (Array.isArray(catalog)) return catalog.some((item) => item && item.id === id);
  return false;
}

/* Reward art lands with the client phase, so an unknown id is permitted but
   never invisible. CI and release tooling can call this validator with the
   catalog they are about to ship and get every unresolved reference together. */
export function validateSeason1Rewards(catalog = COSMETICS_BY_ID) {
  const unknownIds = [];
  for (const tier of SEASON_1_TIERS) {
    for (const id of [tier.freeReward, tier.premiumReward]) {
      if (!catalogHas(catalog, id)) unknownIds.push(id);
    }
  }
  return { valid: unknownIds.length === 0, unknownIds };
}

export function tierForXp(xp, curve = SEASON_1_XP_CURVE) {
  if (!Number.isSafeInteger(xp) || xp < 0)
    throw new TypeError('Battle-pass XP must be a non-negative safe integer.');
  let tier = 0;
  while (tier < curve.length && xp >= curve[tier]) tier++;
  return tier;
}

export function xpToNextTier(xp, curve = SEASON_1_XP_CURVE) {
  const tier = tierForXp(xp, curve);
  return tier === curve.length ? null : curve[tier] - xp;
}

export function season1Status(at) {
  const instant = typeof at === 'number' ? at : new Date(at).getTime();
  if (!Number.isFinite(instant))
    throw new TypeError('Season status needs a valid instant.');
  if (instant < Date.parse(SEASON_1_START)) return 'not-yet-active';
  if (instant >= Date.parse(SEASON_1_END)) return 'ended';
  return 'active';
}
