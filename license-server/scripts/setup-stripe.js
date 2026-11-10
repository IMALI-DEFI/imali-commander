/*
 * Creates (or reuses) the Stripe product, prices and webhook for
 * IMALI Commander Pro, then writes the service's env file.
 * Safe to run again: prices are found by lookup key and the webhook
 * secret is kept if the endpoint already exists.
 *
 *   STRIPE_SECRET_KEY=sk_... node scripts/setup-stripe.js <env-file> <public-url> [existing-env-file]
 *
 * Prints only IDs, never secrets.
 */
import fs from 'node:fs';
import Stripe from 'stripe';

const [envFile, publicUrlArg, existingEnvFile] = process.argv.slice(2);
if (!envFile || !publicUrlArg || !process.env.STRIPE_SECRET_KEY) {
  console.error('Usage: STRIPE_SECRET_KEY=... node scripts/setup-stripe.js <env-file> <public-url> [existing-env-file]');
  process.exit(1);
}
const publicUrl = publicUrlArg.replace(/\/$/, '');
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const PRICES = [
  { lookup: 'imali_commander_pro_monthly', amount: 900, interval: 'month', nickname: 'Pro monthly', env: 'PRICE_MONTHLY' },
  { lookup: 'imali_commander_pro_yearly', amount: 7900, interval: 'year', nickname: 'Pro yearly', env: 'PRICE_YEARLY' },
];
const EVENTS = ['checkout.session.completed', 'customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted'];

function readEnv(file) {
  try {
    return Object.fromEntries(
      fs.readFileSync(file, 'utf8').split('\n').filter(l => /^[A-Z_]+=/.test(l)).map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)])
    );
  } catch {
    return {};
  }
}

const previous = existingEnvFile ? readEnv(existingEnvFile) : {};

// Product + prices
const found = await stripe.prices.list({ lookup_keys: PRICES.map(p => p.lookup), limit: 10 });
const byLookup = Object.fromEntries(found.data.map(p => [p.lookup_key, p]));
let productId = found.data[0] ? (typeof found.data[0].product === 'string' ? found.data[0].product : found.data[0].product.id) : null;

if (!productId) {
  const product = await stripe.products.create({
    name: 'IMALI Commander Pro',
    description: 'Remote HTTPS access and multiple workspaces for IMALI Commander, the safe file-access server for AI assistants.',
    metadata: { app: 'imali_commander', product: 'imali_commander_pro' },
  });
  productId = product.id;
  console.log(`Created product ${productId}`);
} else {
  console.log(`Using product ${productId}`);
}

const priceIds = {};
for (const p of PRICES) {
  let price = byLookup[p.lookup];
  if (!price) {
    price = await stripe.prices.create({
      product: productId,
      currency: 'usd',
      unit_amount: p.amount,
      recurring: { interval: p.interval },
      lookup_key: p.lookup,
      nickname: p.nickname,
      metadata: { app: 'imali_commander' },
    });
    console.log(`Created price ${price.id} (${p.nickname}, $${p.amount / 100}/${p.interval})`);
  } else {
    console.log(`Using price ${price.id} (${p.nickname})`);
  }
  priceIds[p.env] = price.id;
}

// Webhook
const webhookUrl = `${publicUrl}/v1/stripe/webhook`;
const endpoints = await stripe.webhookEndpoints.list({ limit: 100 });
const existing = endpoints.data.find(e => e.url === webhookUrl);
let webhookSecret = previous.STRIPE_WEBHOOK_SECRET || null;

if (existing && webhookSecret) {
  await stripe.webhookEndpoints.update(existing.id, { enabled_events: EVENTS, disabled: false });
  console.log(`Using webhook ${existing.id}`);
} else {
  if (existing) await stripe.webhookEndpoints.del(existing.id); // secret unknown: replace it
  const created = await stripe.webhookEndpoints.create({
    url: webhookUrl,
    enabled_events: EVENTS,
    description: 'IMALI Commander Pro licenses',
    metadata: { app: 'imali_commander' },
  });
  webhookSecret = created.secret;
  console.log(`Created webhook ${created.id} -> ${webhookUrl}`);
}

const lines = {
  PORT: previous.PORT || '4300',
  PUBLIC_URL: publicUrl,
  STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY,
  STRIPE_WEBHOOK_SECRET: webhookSecret,
  PRICE_MONTHLY: priceIds.PRICE_MONTHLY,
  PRICE_YEARLY: priceIds.PRICE_YEARLY,
  MAX_ACTIVATIONS: previous.MAX_ACTIVATIONS || '3',
  TRUST_PROXY: '1',
  DB_PATH: previous.DB_PATH || process.env.DB_PATH_DEFAULT || `${process.cwd()}/data/licenses.db`,
  SUPPORT_EMAIL: previous.SUPPORT_EMAIL || '',
};
fs.writeFileSync(envFile, Object.entries(lines).map(([k, v]) => `${k}=${v}`).join('\n') + '\n', { mode: 0o600 });
console.log(`Wrote ${envFile}`);
