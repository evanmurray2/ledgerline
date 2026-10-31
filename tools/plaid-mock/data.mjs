// Plaid-shaped transaction generator shared by the local mock server and the CPU harness.
let seed = 1;

function rand() {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
}
const pick = (a) => a[Math.floor(rand() * a.length)];

const MERCHANTS = [
  ['Trader Joe’s', 'FOOD_AND_DRINK_GROCERIES', 'TRADER JOE S #123 OAKLAND CA'],
  ['Safeway', 'FOOD_AND_DRINK_GROCERIES', 'SAFEWAY #1234 OAKLAND CA'],
  ['Blue Bottle Coffee', 'FOOD_AND_DRINK_COFFEE', 'SQ *BLUE BOTTLE 0123 OAKLAND CA'],
  ['Uber Eats', 'FOOD_AND_DRINK_RESTAURANT', 'UBER EATS PENDING SAN FRANCISCO CA'],
  ['Shell', 'TRANSPORTATION_GAS', 'SHELL OIL 57444 OAKLAND CA'],
  ['Amazon', 'GENERAL_MERCHANDISE_ONLINE_MARKETPLACES', 'AMAZON MKTPL*2K4RT8 AMZN.COM/BILL WA'],
  ['Costco', 'GENERAL_MERCHANDISE_SUPERSTORES', 'COSTCO WHSE #0145 RICHMOND CA'],
  ['CVS Pharmacy', 'MEDICAL_PHARMACIES_AND_SUPPLEMENTS', 'CVS/PHARMACY #09876 BERKELEY CA'],
  ['Target', 'GENERAL_MERCHANDISE_SUPERSTORES', 'TARGET 00012345 EMERYVILLE CA'],
  ['Netflix', 'ENTERTAINMENT_TV_AND_MOVIES', 'NETFLIX.COM LOS GATOS CA'],
];
export const ACCOUNTS = [
  {
    account_id: 'acc_checking',
    name: 'Plaid Checking',
    type: 'depository',
    subtype: 'checking',
    mask: '0000',
    bal: 4212.4,
  },
  {
    account_id: 'acc_savings',
    name: 'Plaid Saving',
    type: 'depository',
    subtype: 'savings',
    mask: '1111',
    bal: 9400,
  },
  {
    account_id: 'acc_credit',
    name: 'Plaid Credit Card',
    type: 'credit',
    subtype: 'credit card',
    mask: '3333',
    bal: 842.17,
  },
];

export function txn(i, TOTAL) {
  const [merchant, pfc, desc] = pick(MERCHANTS);
  const acct = pick(ACCOUNTS);
  const day = new Date(Date.UTC(2026, 9, 31) - Math.floor((i / TOTAL) * 180) * 86400000)
    .toISOString()
    .slice(0, 10);
  const amount = Math.round(rand() * 20000) / 100 + 1;
  const id = `txn_${String(i).padStart(6, '0')}_${Math.floor(rand() * 1e9).toString(36)}`;
  return {
    account_id: acct.account_id,
    account_owner: null,
    amount,
    authorized_date: day,
    authorized_datetime: null,
    category: ['Shops', 'Food and Drink'],
    category_id: '13005000',
    check_number: null,
    counterparties: [
      {
        confidence_level: 'VERY_HIGH',
        entity_id: `ent_${merchant.length}${i % 97}`,
        logo_url: `https://plaid-merchant-logos.plaid.com/${merchant.replace(/\W/g, '').toLowerCase()}_1.png`,
        name: merchant,
        phone_number: null,
        type: 'merchant',
        website: `${merchant.replace(/\W/g, '').toLowerCase()}.com`,
      },
    ],
    date: day,
    datetime: null,
    iso_currency_code: 'USD',
    location: {
      address: null,
      city: 'Oakland',
      country: null,
      lat: null,
      lon: null,
      postal_code: null,
      region: 'CA',
      store_number: '1234',
    },
    logo_url: `https://plaid-merchant-logos.plaid.com/${merchant.replace(/\W/g, '').toLowerCase()}_1.png`,
    merchant_entity_id: `ent_${merchant.length}${i % 97}`,
    merchant_name: merchant,
    name: desc,
    original_description: desc,
    payment_channel: 'in store',
    payment_meta: {
      by_order_of: null,
      payee: null,
      payer: null,
      payment_method: null,
      payment_processor: null,
      ppd_id: null,
      reason: null,
      reference_number: null,
    },
    pending: false,
    pending_transaction_id: null,
    personal_finance_category: {
      confidence_level: 'VERY_HIGH',
      detailed: pfc,
      primary: pfc.split('_').slice(0, 2).join('_'),
    },
    personal_finance_category_icon_url: 'https://plaid-category-icons.plaid.com/PFC_FOOD_AND_DRINK.png',
    transaction_code: null,
    transaction_id: id,
    transaction_type: 'place',
    unofficial_currency_code: null,
    website: `${merchant.replace(/\W/g, '').toLowerCase()}.com`,
  };
}

export function generate(total, s = 1) {
  seed = s;
  return Array.from({ length: total }, (_, i) => txn(i, total));
}

/** A /transactions/sync response body exactly as the mock server sends it. */
export function syncBody(data, start, count) {
  const added = data.slice(start, start + count);
  const next = start + added.length;
  return JSON.stringify(
    {
      accounts: [],
      added,
      has_more: next < data.length,
      modified: [],
      next_cursor: Buffer.from(String(next)).toString('base64'),
      removed: [],
      request_id: 'req_mock',
      transactions_update_status: 'HISTORICAL_UPDATE_COMPLETE',
    },
    null,
    2,
  );
}
