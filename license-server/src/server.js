import http from 'node:http';
import Stripe from 'stripe';
import { openDb } from './db.js';
import { createApp } from './app.js';

const env = process.env;
const config = {
  port: Number(env.PORT || 4300),
  publicUrl: (env.PUBLIC_URL || 'http://127.0.0.1:4300').replace(/\/$/, ''),
  prices: { monthly: env.PRICE_MONTHLY || null, yearly: env.PRICE_YEARLY || null },
  webhookSecret: env.STRIPE_WEBHOOK_SECRET || null,
  maxActivations: Number(env.MAX_ACTIVATIONS || 3),
  trustProxy: /^(1|true|yes)$/i.test(env.TRUST_PROXY || ''),
  supportEmail: env.SUPPORT_EMAIL || null,
  dbPath: env.DB_PATH || './data/licenses.db',
};

if (!env.STRIPE_SECRET_KEY) {
  console.error('STRIPE_SECRET_KEY is required');
  process.exit(1);
}

const db = openDb(config.dbPath);
const stripe = new Stripe(env.STRIPE_SECRET_KEY);
const server = http.createServer(createApp({ db, stripe, config }));

server.listen(config.port, '127.0.0.1', () => {
  console.log(`IMALI Commander license service on 127.0.0.1:${config.port} (${config.publicUrl})`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => { db.close(); process.exit(0); }));
}
