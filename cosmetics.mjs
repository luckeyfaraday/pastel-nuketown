/* This is a product contract, not a database seed. Later client phases import
   these identifiers directly, while this phase uses the environment-variable
   names to join them to Stripe. Keeping both facts in one frozen catalog means
   a display-name edit cannot accidentally turn an old purchase into a different
   item, and a missing Stripe price can make one item unavailable without
   changing what that item is. */
export const COSMETICS = Object.freeze([
  Object.freeze({
    id: 'smg-cottoncloud',
    displayName: 'Cotton Cloud',
    type: 'weapon',
    slot: 'smg',
    priceEnvVar: 'STRIPE_PRICE_SMG_COTTONCLOUD'
  }),
  Object.freeze({
    id: 'shotgun-toastedmallow',
    displayName: 'Toasted Mallow',
    type: 'weapon',
    slot: 'shotgun',
    priceEnvVar: 'STRIPE_PRICE_SHOTGUN_TOASTEDMALLOW'
  }),
  Object.freeze({
    id: 'rifle-berryswirl',
    displayName: 'Berry Swirl',
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
  })
]);

export const COSMETICS_BY_ID = new Map(
  COSMETICS.map((cosmetic) => [cosmetic.id, cosmetic])
);
