/* Currency amounts are integers everywhere. They are not money and never use
   floating point; Stripe remains the authority for the real-money price of a
   pack, while this catalog is the authority for how many Pastels it grants. */
export const GAME_CURRENCY = Object.freeze({
  code: 'pastels',
  displayName: 'Pastels',
  symbol: '✦'
});

export const CURRENCY_PACKS = Object.freeze([
  Object.freeze({
    id: 'pastels-500',
    displayName: '500 Pastels',
    amount: 500,
    priceEnvVar: 'STRIPE_PRICE_PASTELS_500'
  }),
  Object.freeze({
    id: 'pastels-1100',
    displayName: '1,100 Pastels',
    amount: 1100,
    priceEnvVar: 'STRIPE_PRICE_PASTELS_1100'
  }),
  Object.freeze({
    id: 'pastels-2500',
    displayName: '2,500 Pastels',
    amount: 2500,
    priceEnvVar: 'STRIPE_PRICE_PASTELS_2500'
  })
]);

export const CURRENCY_PACKS_BY_ID = new Map(
  CURRENCY_PACKS.map((pack) => [pack.id, pack])
);
