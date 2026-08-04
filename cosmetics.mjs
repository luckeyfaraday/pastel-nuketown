/* This is a product contract, not a database seed. Later client phases import
   these identifiers directly, while this phase uses the environment-variable
   names to join them to Stripe. Keeping both facts in one frozen catalog means
   a display-name edit cannot accidentally turn an old purchase into a different
   item, and a missing Stripe price can make one item unavailable without
   changing what that item is. */
export const COSMETICS = Object.freeze([
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

export const COSMETICS_BY_ID = new Map(
  COSMETICS.map((cosmetic) => [cosmetic.id, cosmetic])
);
