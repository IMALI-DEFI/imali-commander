/*
 * IMALI Commander Pro license service (Stripe).
 *
 *   GET  /buy[?plan=monthly|yearly]   pricing page, or redirect to Stripe Checkout
 *   GET  /success?session_id=…        shows the license key after payment
 *   GET  /manage, POST /manage        Stripe billing portal by license key
 *   POST /v1/licenses/activate        {key, label}          -> {id, license_key:{status}}
 *   POST /v1/licenses/validate        {key, activation_id?} -> {status:"granted"} or 404
 *   POST /v1/licenses/deactivate      {key, activation_id}  -> 204
 *   POST /v1/stripe/webhook           Stripe events keep license status current
 *   GET  /health
 *
 * A license is "granted" while its Stripe subscription is active, trialing
 * or past_due. Webhooks keep that current; as a fallback the status is
 * re-read from Stripe when it's more than a day old.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import * as pages from './pages.js';

export const PRODUCT = 'imali_commander_pro';
const PLANS = ['monthly', 'yearly'];
const GRANTED = new Set(['active', 'trialing', 'past_due']);
const RECHECK_MS = 24 * 60 * 60 * 1000;
const KEY_ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ0123456789'; // 32 symbols, no I/L/O/U
const KEY_PATTERN = /^IMALI(-[A-Z0-9]{5}){4}$/;
const SESSION_PATTERN = /^cs_(test|live)_[A-Za-z0-9]{10,200}$/;

export const isGranted = license => Boolean(license && GRANTED.has(license.status));

export function newLicenseKey() {
  let s = '';
  for (const b of randomBytes(20)) s += KEY_ALPHABET[b & 31]; // 256 % 32 == 0, so unbiased
  return `IMALI-${s.slice(0, 5)}-${s.slice(5, 10)}-${s.slice(10, 15)}-${s.slice(15, 20)}`;
}

const normKey = value => {
  const key = String(value || '').trim().toUpperCase();
  return KEY_PATTERN.test(key) ? key : null;
};

function makeLimiter(perMinute) {
  const hits = new Map();
  return ip => {
    const t = Date.now();
    let e = hits.get(ip);
    if (!e || t > e.reset) {
      e = { n: 0, reset: t + 60000 };
      hits.set(ip, e);
      if (hits.size > 10000) hits.delete(hits.keys().next().value);
    }
    return ++e.n > perMinute;
  };
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error('Payload too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const raw = await readBody(req, 16 * 1024);
  try { return raw.length ? JSON.parse(raw.toString('utf8')) : {}; }
  catch { throw Object.assign(new Error('Invalid JSON'), { status: 400 }); }
}

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
};

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...SECURITY_HEADERS });
  res.end(status === 204 ? undefined : JSON.stringify(body));
}

function html(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https://billing.stripe.com; base-uri 'none'; frame-ancestors 'none'",
    ...SECURITY_HEADERS,
  });
  res.end(body);
}

function redirect(res, location) {
  res.writeHead(303, { Location: location, ...SECURITY_HEADERS });
  res.end();
}

const notFound = res => json(res, 404, { error: 'ResourceNotFound', detail: 'License key not found, revoked or expired.' });

export function createApp({ db, stripe, config, now = () => Date.now(), log = console }) {
  const max = config.maxActivations || 3;
  const limitApi = makeLimiter(60);
  const limitPages = makeLimiter(20);

  const q = {
    byKey: db.prepare('SELECT * FROM licenses WHERE key = ?'),
    bySub: db.prepare('SELECT * FROM licenses WHERE subscription_id = ?'),
    insert: db.prepare(`INSERT OR IGNORE INTO licenses
      (key, email, plan, customer_id, subscription_id, checkout_session_id, status, created_at, updated_at, checked_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    setStatus: db.prepare('UPDATE licenses SET status = ?, updated_at = ?, checked_at = ? WHERE subscription_id = ?'),
    activeCount: db.prepare('SELECT COUNT(*) AS n FROM activations WHERE license_key = ? AND deactivated_at IS NULL'),
    addActivation: db.prepare('INSERT INTO activations (id, license_key, label, created_at) VALUES (?, ?, ?, ?)'),
    activation: db.prepare('SELECT * FROM activations WHERE id = ? AND license_key = ? AND deactivated_at IS NULL'),
    touchActivation: db.prepare('UPDATE activations SET last_validated_at = ? WHERE id = ?'),
    deactivate: db.prepare('UPDATE activations SET deactivated_at = ? WHERE id = ? AND license_key = ? AND deactivated_at IS NULL'),
  };

  const idOf = value => (typeof value === 'string' ? value : value?.id || null);

  // Idempotent: the success page and the checkout webhook can both call this.
  async function ensureLicense(session) {
    if (session?.mode !== 'subscription' || session?.metadata?.product !== PRODUCT) return { error: 'not_ours' };
    if (session.status !== 'complete') return { error: 'incomplete' };
    let sub = session.subscription;
    if (typeof sub === 'string') sub = await stripe.subscriptions.retrieve(sub);
    if (!sub?.id) return { error: 'incomplete' };

    const existing = q.bySub.get(sub.id);
    if (existing) return { license: existing };
    const t = now();
    q.insert.run(
      newLicenseKey(),
      session.customer_details?.email || null,
      PLANS.includes(session.metadata?.plan) ? session.metadata.plan : null,
      idOf(session.customer),
      sub.id,
      session.id,
      sub.status,
      t, t, t,
    );
    return { license: q.bySub.get(sub.id) };
  }

  async function fresh(license) {
    if (!license.subscription_id || now() - license.checked_at < RECHECK_MS) return license;
    try {
      const sub = await stripe.subscriptions.retrieve(license.subscription_id);
      q.setStatus.run(sub.status, now(), now(), license.subscription_id);
    } catch (e) {
      if (e?.code === 'resource_missing' || e?.statusCode === 404) {
        q.setStatus.run('canceled', now(), now(), license.subscription_id);
      } else {
        log.error(`Stripe status check failed: ${e?.message}`);
        return license; // Stripe unreachable: keep the last known status
      }
    }
    return q.byKey.get(license.key);
  }

  async function grantedLicense(rawKey) {
    const key = normKey(rawKey);
    if (!key) return null;
    const license = q.byKey.get(key);
    if (!license) return null;
    const current = await fresh(license);
    return isGranted(current) ? current : null;
  }

  const routes = {
    'GET /health': (req, res) => json(res, 200, { status: 'ok' }),

    'GET /': (req, res) => redirect(res, `${config.publicUrl}/buy`),

    'GET /buy': async (req, res, { url, ip }) => {
      const plan = url.searchParams.get('plan');
      if (!plan) return html(res, 200, pages.pricing(config));
      if (!PLANS.includes(plan)) return html(res, 400, pages.message('Unknown plan', 'Choose monthly or yearly.'));
      if (limitPages(ip)) return html(res, 429, pages.message('Too many requests', 'Please try again in a minute.'));
      const price = config.prices?.[plan];
      if (!price) return html(res, 503, pages.message('Not on sale yet', 'Pro checkout is being set up. Please check back soon.'));
      const session = await stripe.checkout.sessions.create({
        mode: 'subscription',
        line_items: [{ price, quantity: 1 }],
        success_url: `${config.publicUrl}/success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${config.publicUrl}/buy`,
        allow_promotion_codes: true,
        metadata: { app: 'imali_commander', product: PRODUCT, plan },
        subscription_data: { metadata: { app: 'imali_commander', product: PRODUCT, plan } },
      });
      return redirect(res, session.url);
    },

    'GET /success': async (req, res, { url }) => {
      const id = url.searchParams.get('session_id') || '';
      if (!SESSION_PATTERN.test(id)) return html(res, 400, pages.message('Link not valid', 'This page needs the link Stripe sends you to after checkout.'));
      let session;
      try {
        session = await stripe.checkout.sessions.retrieve(id, { expand: ['subscription'] });
      } catch {
        return html(res, 404, pages.message('Checkout not found', 'We could not find that checkout. If you were charged, contact support.'));
      }
      const result = await ensureLicense(session);
      if (result.error === 'not_ours') return html(res, 404, pages.message('Checkout not found', 'That checkout is not for IMALI Commander Pro.'));
      if (result.error === 'incomplete') return html(res, 202, pages.processing());
      return html(res, 200, pages.success(result.license, config));
    },

    'GET /manage': (req, res) => html(res, 200, pages.manage(config)),

    'POST /manage': async (req, res, { ip }) => {
      if (limitPages(ip)) return html(res, 429, pages.message('Too many requests', 'Please try again in a minute.'));
      const form = new URLSearchParams((await readBody(req, 4096)).toString('utf8'));
      const key = normKey(form.get('key'));
      const license = key ? q.byKey.get(key) : null;
      if (!license?.customer_id) return html(res, 404, pages.manage(config, 'We could not find that license key. Check it and try again.'));
      try {
        const portal = await stripe.billingPortal.sessions.create({ customer: license.customer_id, return_url: `${config.publicUrl}/manage` });
        return redirect(res, portal.url);
      } catch (e) {
        log.error(`Billing portal failed: ${e?.message}`);
        return html(res, 503, pages.manage(config, 'The billing portal is not available right now. Please contact support.'));
      }
    },

    'POST /v1/licenses/activate': async (req, res, { ip }) => {
      if (limitApi(ip)) return json(res, 429, { error: 'TooManyRequests' });
      const body = await readJson(req);
      const license = await grantedLicense(body.key);
      if (!license) return notFound(res);
      if (q.activeCount.get(license.key).n >= max) {
        return json(res, 403, { error: 'ActivationLimit', detail: `This license is already active on ${max} machines.` });
      }
      const id = randomUUID();
      const label = String(body.label || '').slice(0, 100);
      q.addActivation.run(id, license.key, label, now());
      return json(res, 200, { id, label, license_key: { status: 'granted', expires_at: null, limit_activations: max } });
    },

    'POST /v1/licenses/validate': async (req, res, { ip }) => {
      if (limitApi(ip)) return json(res, 429, { error: 'TooManyRequests' });
      const body = await readJson(req);
      const license = await grantedLicense(body.key);
      if (!license) return notFound(res);
      if (body.activation_id) {
        const activation = q.activation.get(String(body.activation_id), license.key);
        if (!activation) return notFound(res);
        q.touchActivation.run(now(), activation.id);
      }
      return json(res, 200, { status: 'granted', expires_at: null, limit_activations: max });
    },

    'POST /v1/licenses/deactivate': async (req, res, { ip }) => {
      if (limitApi(ip)) return json(res, 429, { error: 'TooManyRequests' });
      const body = await readJson(req);
      const key = normKey(body.key);
      if (key && body.activation_id) q.deactivate.run(now(), String(body.activation_id), key);
      return json(res, 204);
    },

    'POST /v1/stripe/webhook': async (req, res) => {
      if (!config.webhookSecret) return json(res, 503, { error: 'WebhookNotConfigured' });
      const raw = await readBody(req, 1024 * 1024);
      let event;
      try {
        event = stripe.webhooks.constructEvent(raw, req.headers['stripe-signature'], config.webhookSecret);
      } catch {
        return json(res, 400, { error: 'BadSignature' });
      }
      const obj = event.data?.object;
      switch (event.type) {
        case 'checkout.session.completed':
          await ensureLicense(obj);
          break;
        case 'customer.subscription.created':
        case 'customer.subscription.updated':
        case 'customer.subscription.deleted':
          // Updates only subscriptions that belong to a Commander license.
          q.setStatus.run(event.type.endsWith('deleted') ? 'canceled' : obj.status, now(), now(), obj.id);
          break;
        default:
          break;
      }
      return json(res, 200, { received: true });
    },
  };

  return async function handler(req, res) {
    const url = new URL(req.url, 'http://local');
    const ip = (config.trustProxy && req.headers['x-real-ip']) || req.socket.remoteAddress || 'unknown';
    const route = routes[`${req.method} ${url.pathname.replace(/\/+$/, '') || '/'}`];
    try {
      if (!route) return json(res, 404, { error: 'NotFound' });
      await route(req, res, { url, ip });
    } catch (e) {
      if (!e.status) log.error(e);
      if (!res.headersSent) json(res, e.status || 500, { error: e.status ? e.message : 'InternalError' });
    }
  };
}
