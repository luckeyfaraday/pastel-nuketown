/* This is a product contract, not a database seed. Later client phases import
   these identifiers directly, while this phase uses the environment-variable
   names to join them to Stripe. Keeping both facts in one frozen catalog means
   a display-name edit cannot accidentally turn an old purchase into a different
   item, and a missing Stripe price can make one item unavailable without
   changing what that item is. */

/* Shop-sold cosmetics only. Battle-pass rewards live in BATTLEPASS_COSMETICS
   and are merged into COSMETICS / COSMETICS_BY_ID for shape validation and
   renderer metadata. Ownership is the union of paid entitlements and active
   battle-pass claims; reward ids never enter STORE_PRODUCTS — that is what
   keeps them off the shop and out of checkout. */
export const SHOP_COSMETICS = Object.freeze([
  Object.freeze({
    id: 'smg-cottoncloud',
    displayName: 'Folded Paper Crane',
    type: 'weapon',
    slot: 'smg',
    priceEnvVar: 'STRIPE_PRICE_SMG_COTTONCLOUD'
  }),
  Object.freeze({
    id: 'shotgun-toastedmallow',
    displayName: 'Cobalt Willow Teapot',
    type: 'weapon',
    slot: 'shotgun',
    priceEnvVar: 'STRIPE_PRICE_SHOTGUN_TOASTEDMALLOW'
  }),
  Object.freeze({
    id: 'rifle-berryswirl',
    displayName: 'Twisted Glass Cane',
    type: 'weapon',
    slot: 'rifle',
    priceEnvVar: 'STRIPE_PRICE_RIFLE_BERRYSWIRL'
  }),
  Object.freeze({
    id: 'char-midnight',
    displayName: 'Midnight',
    type: 'character',
    slot: null,
    priceEnvVar: 'STRIPE_PRICE_CHAR_MIDNIGHT'
  }),
  Object.freeze({
    id: 'char-sherbetfox',
    displayName: 'Sherbet Fox',
    type: 'character',
    slot: null,
    priceEnvVar: 'STRIPE_PRICE_CHAR_SHERBETFOX'
  }),
  Object.freeze({
    id: 'char-cloudknight',
    displayName: 'Cloud Knight',
    type: 'character',
    slot: null,
    priceEnvVar: 'STRIPE_PRICE_CHAR_CLOUDKNIGHT'
  }),
  /* Shot effects carry `slot: null` for the same reason a character does: a
     player wears exactly one at a time, so there is no sub-slot to name. A
     weapon skin needs a slot because there are three guns and a skin fits
     precisely one of them; an effect themes every shot from every gun, which
     is the whole of what makes it one purchase rather than three. The relay's
     catalogAcceptsCosmetic compares `slot` to whatever sanitizeCosmetics
     passes for the kind, and it passes null for a slotless cosmetic, so this
     value is what keeps an effect from being claimed into a weapon slot. */
  Object.freeze({
    id: 'fx-starfall',
    displayName: 'Starfall',
    type: 'effect',
    slot: null,
    priceEnvVar: 'STRIPE_PRICE_FX_STARFALL'
  }),
  Object.freeze({
    id: 'fx-confettipop',
    displayName: 'Confetti Pop',
    type: 'effect',
    slot: null,
    priceEnvVar: 'STRIPE_PRICE_FX_CONFETTIPOP'
  }),
  Object.freeze({
    id: 'fx-bubbletrail',
    displayName: 'Bubble Trail',
    type: 'effect',
    slot: null,
    priceEnvVar: 'STRIPE_PRICE_FX_BUBBLETRAIL'
  })
]);

/* Battle-pass rewards are earned on the ladder, never sold. priceEnvVar is
   null because no Stripe price is bound; exclusion from STORE_PRODUCTS is
   what keeps catalog() and checkout() from offering them. */
function bpCosmetic(id, displayName, type, slot) {
  return Object.freeze({ id, displayName, type, slot, priceEnvVar: null });
}

export const BATTLEPASS_COSMETICS = Object.freeze([
  // Free lane
  bpCosmetic('s1-free-smg-first-light', 'First Light Blush', 'weapon', 'smg'),
  bpCosmetic('s1-free-fx-paper-star', 'Paper Star', 'effect', null),
  bpCosmetic('s1-free-char-pink-horizon', 'Pink Horizon', 'character', null),
  bpCosmetic('s1-free-shotgun-cloud-nine', 'Cloud Nine', 'weapon', 'shotgun'),
  bpCosmetic('s1-free-fx-soft-confetti', 'Soft Confetti', 'effect', null),
  bpCosmetic('s1-free-shotgun-tiny-teapot', 'Tiny Teapot', 'weapon', 'shotgun'),
  bpCosmetic('s1-free-smg-bus-stop', 'Bus Stop', 'weapon', 'smg'),
  bpCosmetic('s1-free-char-blue-bird', 'Blue Bird', 'character', null),
  bpCosmetic('s1-free-rifle-sunny-side', 'Sunny Side', 'weapon', 'rifle'),
  bpCosmetic('s1-free-rifle-pastel-stripe', 'Pastel Stripe', 'weapon', 'rifle'),
  bpCosmetic('s1-free-fx-glass-drop', 'Glass Drop', 'effect', null),
  bpCosmetic('s1-free-char-nuketown-night', 'Nuketown Night', 'character', null),
  bpCosmetic('s1-free-fx-lucky-thirteen', 'Lucky Thirteen', 'effect', null),
  bpCosmetic('s1-free-smg-garden-wall', 'Garden Wall', 'weapon', 'smg'),
  bpCosmetic('s1-free-fx-paper-petals', 'Paper Petals', 'effect', null),
  bpCosmetic('s1-free-smg-pocket-sun', 'Pocket Sun', 'weapon', 'smg'),
  bpCosmetic('s1-free-shotgun-sherbet-streak', 'Sherbet Streak', 'weapon', 'shotgun'),
  bpCosmetic('s1-free-rifle-tower-watch', 'Tower Watch', 'weapon', 'rifle'),
  bpCosmetic('s1-free-fx-house-party', 'House Party', 'effect', null),
  bpCosmetic('s1-free-char-cotton-cadet', 'Cotton Cadet', 'character', null),
  bpCosmetic('s1-free-smg-little-rocket', 'Little Rocket', 'weapon', 'smg'),
  bpCosmetic('s1-free-rifle-final-lap', 'Final Lap', 'weapon', 'rifle'),
  bpCosmetic('s1-free-char-golden-ticket', 'Golden Ticket', 'character', null),
  bpCosmetic('s1-free-shotgun-almost-there', 'Almost There', 'weapon', 'shotgun'),
  bpCosmetic('s1-free-rifle-season-one', 'Season One', 'weapon', 'rifle'),
  // Premium lane
  bpCosmetic('s1-premium-smg-first-light', 'First Light Gold', 'weapon', 'smg'),
  bpCosmetic('s1-premium-fx-dawn-sparks', 'Dawn Sparks', 'effect', null),
  bpCosmetic('s1-premium-char-sunrise-scout', 'Sunrise Scout', 'character', null),
  bpCosmetic('s1-premium-shotgun-peach-frost', 'Peach Frost', 'weapon', 'shotgun'),
  bpCosmetic('s1-premium-rifle-sky-ribbon', 'Sky Ribbon', 'weapon', 'rifle'),
  bpCosmetic('s1-premium-char-lilac-guard', 'Lilac Guard', 'character', null),
  bpCosmetic('s1-premium-fx-prism-pop', 'Prism Pop', 'effect', null),
  bpCosmetic('s1-premium-smg-candy-grid', 'Candy Grid', 'weapon', 'smg'),
  bpCosmetic('s1-premium-shotgun-moon-mallow', 'Moon Mallow', 'weapon', 'shotgun'),
  bpCosmetic('s1-premium-char-neon-nap', 'Neon Nap', 'character', null),
  bpCosmetic('s1-premium-fx-comet-tail', 'Comet Tail', 'effect', null),
  bpCosmetic('s1-premium-smg-berry-static', 'Berry Static', 'weapon', 'smg'),
  bpCosmetic('s1-premium-char-starlight-runner', 'Starlight Runner', 'character', null),
  bpCosmetic('s1-premium-shotgun-gilded-cloud', 'Gilded Cloud', 'weapon', 'shotgun'),
  bpCosmetic('s1-premium-rifle-midnight-bloom', 'Midnight Bloom', 'weapon', 'rifle'),
  bpCosmetic('s1-premium-char-cobalt-captain', 'Cobalt Captain', 'character', null),
  bpCosmetic('s1-premium-fx-aurora-trail', 'Aurora Trail', 'effect', null),
  bpCosmetic('s1-premium-smg-prism-check', 'Prism Check', 'weapon', 'smg'),
  bpCosmetic('s1-premium-shotgun-starlight', 'Starlight', 'weapon', 'shotgun'),
  bpCosmetic('s1-premium-rifle-sunset-glass', 'Sunset Glass', 'weapon', 'rifle'),
  bpCosmetic('s1-premium-fx-crown-burst', 'Crown Burst', 'effect', null),
  bpCosmetic('s1-premium-char-dream-warden', 'Dream Warden', 'character', null),
  bpCosmetic('s1-premium-smg-royal-sherbet', 'Royal Sherbet', 'weapon', 'smg'),
  bpCosmetic('s1-premium-shotgun-aurora-crown', 'Aurora Crown', 'weapon', 'shotgun'),
  bpCosmetic('s1-premium-char-season-one-legend', 'Season One Legend', 'character', null)
]);

export const COSMETICS = Object.freeze([
  ...SHOP_COSMETICS,
  ...BATTLEPASS_COSMETICS
]);

export const COSMETICS_BY_ID = new Map(
  COSMETICS.map((cosmetic) => [cosmetic.id, cosmetic])
);

/* The pass uses the store's existing product contract but is not a wearable
   cosmetic. Keeping it out of COSMETICS prevents preview/equip validation from
   treating it as appearance; the shop can withhold it from its public listing
   while STORE_PRODUCTS_BY_ID keeps checkout and webhooks able to resolve it. */
export const PREMIUM_PASS_ID = 'battlepass-season-1-premium';
export const PREMIUM_PASS_PRODUCT = Object.freeze({
  id: PREMIUM_PASS_ID,
  displayName: 'Season 1 Premium Pass',
  type: 'battlepass',
  slot: null,
  priceEnvVar: 'STRIPE_PRICE_BATTLEPASS_SEASON_1_PREMIUM'
});

/* Only shop cosmetics and the premium pass itself. Battle-pass reward ids are
   intentionally omitted so they cannot appear in the storefront or be bought
   with a Stripe price id, even if someone invents an env binding for them. */
export const STORE_PRODUCTS = Object.freeze([
  ...SHOP_COSMETICS,
  PREMIUM_PASS_PRODUCT
]);

export const STORE_PRODUCTS_BY_ID = new Map(
  STORE_PRODUCTS.map((product) => [product.id, product])
);
