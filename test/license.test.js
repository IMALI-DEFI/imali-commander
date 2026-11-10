// End to end: the Commander CLI and server against the real license service
// (license-server/src) with an in-memory Stripe.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { isolatedEnv, runCli, tmp } from './helpers.js';
import { licenseState, OFFLINE_GRACE_MS } from '../src/license.js';
import { checkRemoteAllowed } from '../src/http.js';
import { openDb } from '../license-server/src/db.js';
import { createApp } from '../license-server/src/app.js';
import { fakeStripe, WEBHOOK_SIGNATURE } from '../license-server/test/fakeStripe.js';

const stripe = fakeStripe();
const db = openDb(':memory:');
const server = http.createServer(createApp({
  db,
  stripe,
  config: { publicUrl: 'http://license.test', prices: { monthly: 'price_m', yearly: 'price_y' }, webhookSecret: 'whsec', maxActivations: 3 },
  log: { error: () => {} },
}));
await new Promise(r => server.listen(0, '127.0.0.1', r));
test.after(() => server.close());
const API = `http://127.0.0.1:${server.address().port}`;

let purchases = 0;
async function buyLicense() {
  const id = `cs_test_commander${String(++purchases).padStart(5, '0')}`;
  const subId = stripe.addCheckout(id);
  const page = await (await fetch(`${API}/success?session_id=${id}`)).text();
  return { key: /IMALI(-[A-Z0-9]{5}){4}/.exec(page)[0], subId };
}

async function cancel(subId) {
  await fetch(`${API}/v1/stripe/webhook`, {
    method: 'POST',
    headers: { 'Stripe-Signature': WEBHOOK_SIGNATURE },
    body: JSON.stringify({ type: 'customer.subscription.deleted', data: { object: { id: subId, status: 'canceled' } } }),
  });
}

const activeActivations = key =>
  db.prepare('SELECT COUNT(*) AS n FROM activations WHERE license_key = ? AND deactivated_at IS NULL').get(key).n;

const licEnv = extra => isolatedEnv({ IMALI_LICENSE_API: API, IMALI_BUY_URL: 'https://example.com/pro', ...extra });

async function toolsFor(env) {
  const client = new Client({ name: 'lic-test', version: '1' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: ['src/server.js'], env }));
  return client;
}

test('Free by default, Pro after activation, back to Free when cancelled', async () => {
  const { key, subId } = await buyLicense();
  const env = await licEnv({ IMALI_WORKSPACE: await tmp('imali-lic-main-') });

  let r = await runCli(['license'], env);
  assert.match(r.stdout, /Edition: Free/);
  assert.match(r.stdout, /example\.com\/pro/);

  r = await runCli(['workspace', 'add', 'docs', await tmp('imali-lic-docs-')], env);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /part of IMALI Commander Pro/);

  r = await runCli(['activate', 'IMALI-AAAAA-AAAAA-AAAAA-AAAAA'], env);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /not found/);

  r = await runCli(['activate', key.toLowerCase()], env);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /Pro is active/);
  const config = JSON.parse(fs.readFileSync(path.join(env.IMALI_HOME, 'config.json'), 'utf8'));
  assert.equal(config.license.key, key);
  assert.ok(config.license.activationId);
  assert.equal(activeActivations(key), 1);
  assert.match((await runCli(['status'], env)).stdout, /\(Pro\)/);

  const docs = await tmp('imali-lic-docs-');
  fs.writeFileSync(path.join(docs, 'readme.txt'), 'from docs');
  r = await runCli(['workspace', 'add', 'docs', docs], env);
  assert.equal(r.code, 0, r.stderr);
  assert.match((await runCli(['workspace', 'list'], env)).stdout, /docs/);

  let client = await toolsFor(env);
  try {
    const readTool = (await client.listTools()).tools.find(t => t.name === 'read_file');
    assert.ok(readTool.inputSchema.properties.workspace);
    assert.deepEqual(readTool.inputSchema.required, ['file']);
    const fromDocs = await client.callTool({ name: 'read_file', arguments: { file: 'readme.txt', workspace: 'docs' } });
    assert.equal(fromDocs.content[0].text, 'from docs');
    const fromMain = await client.callTool({ name: 'read_file', arguments: { file: 'readme.txt' } });
    assert.equal(fromMain.isError, true, 'default workspace is main, not docs');
    const unknown = await client.callTool({ name: 'list_files', arguments: { workspace: 'nope' } });
    assert.match(unknown.content[0].text, /Unknown workspace "nope"/);
    const info = JSON.parse((await client.callTool({ name: 'device_info', arguments: {} })).content[0].text);
    assert.deepEqual(info.workspaces, ['main', 'docs']);
  } finally {
    await client.close();
  }

  // Customer cancels in Stripe: next check drops to Free and extra workspaces unload.
  await cancel(subId);
  r = await runCli(['license', '--check'], env);
  assert.match(r.stdout, /Edition: Free/);
  assert.match(r.stdout, /no longer valid/);
  client = await toolsFor(env);
  try {
    const readTool = (await client.listTools()).tools.find(t => t.name === 'read_file');
    assert.equal(readTool.inputSchema.properties.workspace, undefined, 'Free schema is unchanged');
  } finally {
    await client.close();
  }
});

test('deactivate frees the seat; the machine limit is enforced', async () => {
  const { key } = await buyLicense();
  const envs = [await licEnv(), await licEnv(), await licEnv(), await licEnv()];
  for (const env of envs.slice(0, 3)) assert.equal((await runCli(['activate', key], env)).code, 0);
  const fourth = await runCli(['activate', key], envs[3]);
  assert.equal(fourth.code, 1);
  assert.match(fourth.stderr, /maximum|3 machines/);

  const r = await runCli(['deactivate'], envs[0]);
  assert.match(r.stdout, /License removed/);
  assert.equal(activeActivations(key), 2);
  assert.match((await runCli(['license'], envs[0])).stdout, /Edition: Free/);
  assert.equal((await runCli(['activate', key], envs[3])).code, 0, 'freed seat works on another machine');
});

test('Docker-style IMALI_LICENSE_KEY activates once and is reused', async () => {
  const { key } = await buyLicense();
  const env = await licEnv({ IMALI_WORKSPACE: await tmp('imali-lic-env-'), IMALI_LICENSE_KEY: key });
  let client = await toolsFor(env);
  await client.close();
  client = await toolsFor(env);
  await client.close();
  assert.equal(activeActivations(key), 1, 'second start reuses the stored activation');
});

test('unreachable license service gives a clear error', async () => {
  const env = await isolatedEnv({ IMALI_LICENSE_API: 'http://127.0.0.1:9' });
  const r = await runCli(['activate', 'IMALI-AAAAA-AAAAA-AAAAA-AAAAA'], env);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /Could not reach the license service/);
});

test('offline grace: 7 days from the last good check', () => {
  const now = Date.now();
  const key = 'IMALI-ABCDE-FGHJK-MNPQR-0001';
  const license = checkedAgo => ({ license: { key, status: 'granted', checkedAt: new Date(now - checkedAgo).toISOString() } });
  assert.equal(licenseState(license(OFFLINE_GRACE_MS - 60000), now).edition, 'pro');
  assert.equal(licenseState(license(OFFLINE_GRACE_MS + 60000), now).edition, 'free');
  assert.equal(licenseState({ license: { key, status: 'granted', checkedAt: new Date(now).toISOString(), expiresAt: new Date(now - 1000).toISOString() } }, now).edition, 'free');
  assert.equal(licenseState({}, now).edition, 'free');
  assert.equal(licenseState(license(0), now).key, 'IMALI-…0001');
});

test('remote access requires Pro; localhost never does', () => {
  assert.doesNotThrow(() => checkRemoteAllowed({ host: '127.0.0.1', allowRemote: false }, false));
  assert.throws(() => checkRemoteAllowed({ host: '0.0.0.0', allowRemote: false }, true), /Refusing to bind beyond localhost/);
  assert.throws(() => checkRemoteAllowed({ host: '0.0.0.0', allowRemote: true }, false), /Remote access is part of IMALI Commander Pro/);
  assert.doesNotThrow(() => checkRemoteAllowed({ host: '0.0.0.0', allowRemote: true }, true));
});
