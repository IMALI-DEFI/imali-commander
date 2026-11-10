import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { openDb } from '../src/db.js';
import { createApp, newLicenseKey } from '../src/app.js';
import { fakeStripe, WEBHOOK_SIGNATURE } from './fakeStripe.js';

let clock = Date.now();
const stripe = fakeStripe();
const db = openDb(':memory:');
const config = {
  publicUrl: 'https://api.example.com/commander',
  prices: { monthly: 'price_month', yearly: 'price_year' },
  webhookSecret: 'whsec_test',
  maxActivations: 3,
  supportEmail: 'help@example.com',
};
const quiet = { error: () => {} };
const server = http.createServer(createApp({ db, stripe, config, now: () => clock, log: quiet }));
await new Promise(r => server.listen(0, '127.0.0.1', r));
test.after(() => server.close());
const base = `http://127.0.0.1:${server.address().port}`;

const get = path => fetch(base + path, { redirect: 'manual' });
const post = (path, body, headers = {}) =>
  fetch(base + path, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
const keyFrom = page => /IMALI(-[A-Z0-9]{5}){4}/.exec(page)?.[0];

async function buy(sessionId, opts) {
  const subId = stripe.addCheckout(sessionId, opts);
  const res = await get(`/success?session_id=${sessionId}`);
  return { res, page: await res.text(), subId };
}

test('license keys are well-formed and random', () => {
  const keys = new Set(Array.from({ length: 200 }, newLicenseKey));
  assert.equal(keys.size, 200);
  for (const k of keys) assert.match(k, /^IMALI(-[A-HJKMNP-TV-Z0-9]{5}){4}$/);
});

test('pricing page and checkout redirect', async () => {
  const page = await get('/buy');
  assert.equal(page.status, 200);
  const htmlText = await page.text();
  assert.match(htmlText, /\$9/);
  assert.match(htmlText, /\$79/);
  assert.match(page.headers.get('content-security-policy'), /default-src 'none'/);

  const res = await get('/buy?plan=yearly');
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), 'https://checkout.stripe.test/pay/cs_test_newsession0001');
  const params = stripe.created.at(-1);
  assert.equal(params.mode, 'subscription');
  assert.deepEqual(params.line_items, [{ price: 'price_year', quantity: 1 }]);
  assert.equal(params.metadata.product, 'imali_commander_pro');
  assert.equal(params.subscription_data.metadata.plan, 'yearly');
  assert.equal(params.success_url, 'https://api.example.com/commander/success?session_id={CHECKOUT_SESSION_ID}');

  assert.equal((await get('/buy?plan=lifetime')).status, 400);
  assert.equal((await get('/')).headers.get('location'), 'https://api.example.com/commander/buy');
});

test('success page issues one key per purchase, idempotently', async () => {
  const { res, page } = await buy('cs_test_purchase00001');
  assert.equal(res.status, 200);
  const key = keyFrom(page);
  assert.ok(key, 'key shown');
  assert.match(page, new RegExp(`imali-commander activate ${key}`));
  const again = await get('/success?session_id=cs_test_purchase00001');
  assert.equal(keyFrom(await again.text()), key, 'reloading shows the same key');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM licenses').get().n, 1);
  const row = db.prepare('SELECT * FROM licenses WHERE key = ?').get(key);
  assert.equal(row.email, 'buyer@example.com');
  assert.equal(row.plan, 'monthly');
});

test('success page rejects unpaid, foreign and malformed checkouts', async () => {
  assert.equal((await buy('cs_test_unpaid0000001', { status: 'open' })).res.status, 202);
  assert.equal((await buy('cs_test_sportsjedi0001', { product: 'sports_jedi_pro' })).res.status, 404);
  assert.equal((await get('/success?session_id=cs_test_doesnotexist01')).status, 404);
  assert.equal((await get('/success?session_id=<script>')).status, 400);
});

test('activate, validate, activation limit and deactivate', async () => {
  const { page } = await buy('cs_test_activation0001');
  const key = keyFrom(page);

  const bad = await post('/v1/licenses/activate', { key: 'IMALI-AAAAA-AAAAA-AAAAA-AAAAA', label: 'x' });
  assert.equal(bad.status, 404);
  assert.equal((await post('/v1/licenses/activate', { key: 'nonsense' })).status, 404);

  const ids = [];
  for (let i = 0; i < 3; i++) {
    const r = await post('/v1/licenses/activate', { key: key.toLowerCase(), label: `mac-${i}` });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.license_key.status, 'granted');
    ids.push(body.id);
  }
  const fourth = await post('/v1/licenses/activate', { key, label: 'mac-3' });
  assert.equal(fourth.status, 403);
  assert.equal((await fourth.json()).error, 'ActivationLimit');

  const ok = await post('/v1/licenses/validate', { key, activation_id: ids[0] });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).status, 'granted');
  assert.equal((await post('/v1/licenses/validate', { key, activation_id: 'not-mine' })).status, 404);
  assert.equal((await post('/v1/licenses/validate', { key })).status, 200);

  assert.equal((await post('/v1/licenses/deactivate', { key, activation_id: ids[0] })).status, 204);
  assert.equal((await post('/v1/licenses/validate', { key, activation_id: ids[0] })).status, 404);
  assert.equal((await post('/v1/licenses/activate', { key, label: 'new-mac' })).status, 200, 'freed seat can be reused');
});

test('webhooks: signature required; cancellation revokes, reactivation restores', async () => {
  const { page, subId } = await buy('cs_test_webhook000001');
  const key = keyFrom(page);
  const event = status => ({ type: status === 'deleted' ? 'customer.subscription.deleted' : 'customer.subscription.updated', data: { object: { id: subId, status: status === 'deleted' ? 'canceled' : status } } });

  assert.equal((await post('/v1/stripe/webhook', event('deleted'), { 'Stripe-Signature': 'forged' })).status, 400);
  assert.equal((await post('/v1/licenses/validate', { key })).status, 200, 'forged event changed nothing');

  assert.equal((await post('/v1/stripe/webhook', event('deleted'), { 'Stripe-Signature': WEBHOOK_SIGNATURE })).status, 200);
  assert.equal((await post('/v1/licenses/validate', { key })).status, 404);

  await post('/v1/stripe/webhook', event('active'), { 'Stripe-Signature': WEBHOOK_SIGNATURE });
  assert.equal((await post('/v1/licenses/validate', { key })).status, 200);

  await post('/v1/stripe/webhook', event('past_due'), { 'Stripe-Signature': WEBHOOK_SIGNATURE });
  assert.equal((await post('/v1/licenses/validate', { key })).status, 200, 'past_due keeps access during card retries');
});

test('checkout.session.completed webhook creates the license even if the buyer closed the tab', async () => {
  stripe.addCheckout('cs_test_closedtab0001');
  const session = await stripe.checkout.sessions.retrieve('cs_test_closedtab0001');
  const r = await post('/v1/stripe/webhook', { type: 'checkout.session.completed', data: { object: session } }, { 'Stripe-Signature': WEBHOOK_SIGNATURE });
  assert.equal(r.status, 200);
  const row = db.prepare('SELECT * FROM licenses WHERE checkout_session_id = ?').get('cs_test_closedtab0001');
  assert.ok(row);
  const page = await (await get('/success?session_id=cs_test_closedtab0001')).text();
  assert.equal(keyFrom(page), row.key, 'success page shows the same key the webhook created');
});

test('daily re-check with Stripe catches missed webhooks; outages keep access', async () => {
  const { page, subId } = await buy('cs_test_recheck000001');
  const key = keyFrom(page);
  stripe.subs.get(subId).status = 'canceled'; // changed in Stripe, webhook never arrived

  assert.equal((await post('/v1/licenses/validate', { key })).status, 200, 'within a day: cached status');

  clock += 25 * 60 * 60 * 1000;
  stripe.down = true;
  assert.equal((await post('/v1/licenses/validate', { key })).status, 200, 'Stripe down: keep last known status');

  stripe.down = false;
  assert.equal((await post('/v1/licenses/validate', { key })).status, 404, 'Stripe reachable: cancellation applied');
});

test('manage page opens the billing portal for a valid key only', async () => {
  const { page } = await buy('cs_test_portal0000001');
  const key = keyFrom(page);
  const form = body => fetch(`${base}/manage`, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  const ok = await form(`key=${encodeURIComponent(key)}`);
  assert.equal(ok.status, 303);
  assert.match(ok.headers.get('location'), /^https:\/\/billing\.stripe\.test\/session\/cus_/);
  assert.equal((await form('key=IMALI-AAAAA-AAAAA-AAAAA-AAAAA')).status, 404);
  assert.equal((await get('/manage')).status, 200);
});

test('bad input and unknown routes', async () => {
  assert.equal((await post('/v1/licenses/validate', '{not json')).status, 400);
  assert.equal((await get('/nope')).status, 404);
  assert.equal((await (await get('/health')).json()).status, 'ok');
});
