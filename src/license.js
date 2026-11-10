/*
 * IMALI Commander Pro licensing (Stripe-backed IMALI license service).
 *
 * - The Free edition never touches the network.
 * - `imali-commander activate <key>` registers this machine with the
 *   license service and stores the key + activation in config.json (mode 600).
 * - Pro status is re-validated at most once a day. If the service can't be
 *   reached, the last good check counts for 7 days (offline grace).
 * - A cancelled, refunded or unpaid subscription (service answers 404)
 *   drops back to Free.
 *
 * Exports used elsewhere: activateLicense, deactivateLicense, refreshLicense,
 * licenseState, ensureEnvLicense, proMessage, buyUrl, maskKey, OFFLINE_GRACE_MS.
 */
import os from 'node:os';
import { readConfig, writeConfig } from './config.js';

const DEFAULT_LICENSE_API = 'https://api.imali-defi.com/commander';

const DAY_MS = 24 * 60 * 60 * 1000;
export const OFFLINE_GRACE_MS = 7 * DAY_MS;
const RECHECK_MS = DAY_MS;

export const licenseApi = (env = process.env) => (env.IMALI_LICENSE_API || DEFAULT_LICENSE_API).replace(/\/$/, '');
export const buyUrl = (env = process.env) => env.IMALI_BUY_URL || `${licenseApi(env)}/buy`;

export function proMessage(feature, env = process.env) {
  return `${feature} is part of IMALI Commander Pro. Get a license at ${buyUrl(env)}, then run: imali-commander activate <license-key>`;
}

export const maskKey = key => (key ? `${String(key).slice(0, 6)}…${String(key).slice(-4)}` : null);

async function post(env, path, body) {
  const res = await fetch(`${licenseApi(env)}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': 'imali-commander' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  const json = res.status === 204 ? {} : await res.json().catch(() => ({}));
  return { status: res.status, json };
}

function expired(license, now) {
  return Boolean(license?.expiresAt && new Date(license.expiresAt).getTime() <= now);
}

/* Pure: decide the edition from what's stored. */
export function licenseState(config, now = Date.now()) {
  const license = config?.license;
  if (!license?.key) return { edition: 'free', reason: 'No license activated' };
  const base = { key: maskKey(license.key), checkedAt: license.checkedAt || null, expiresAt: license.expiresAt || null };
  if (license.status !== 'granted') return { ...base, edition: 'free', reason: 'License is no longer valid (subscription cancelled, refunded or unpaid)' };
  if (expired(license, now)) return { ...base, edition: 'free', reason: 'License expired' };
  const checked = license.checkedAt ? new Date(license.checkedAt).getTime() : 0;
  if (now - checked > OFFLINE_GRACE_MS) {
    return { ...base, edition: 'free', reason: "License couldn't be verified for 7 days; connect to the internet and run: imali-commander license --check" };
  }
  return { ...base, edition: 'pro', reason: null, graceUntil: new Date(checked + OFFLINE_GRACE_MS).toISOString() };
}

export async function activateLicense(key, env = process.env) {
  const cleanKey = String(key || '').trim().toUpperCase();
  if (cleanKey.length < 8 || cleanKey.length > 200) throw new Error('That does not look like a license key.');

  const label = `${os.hostname()} (${process.platform})`.slice(0, 100);
  let res;
  try {
    res = await post(env, '/v1/licenses/activate', { key: cleanKey, label });
  } catch {
    throw new Error(`Could not reach the license service (${licenseApi(env)}). Check your internet connection and try again.`);
  }
  if (res.status === 404) throw new Error('License key not found, or its subscription is no longer active.');
  if (res.status === 403) throw new Error(`${res.json.detail || 'This license is active on its maximum number of machines.'} Run "imali-commander deactivate" on one you no longer use.`);
  if (res.status === 429) throw new Error('Too many attempts. Wait a minute and try again.');
  if (res.status !== 200 || res.json.license_key?.status !== 'granted') {
    throw new Error(`Could not activate the license (HTTP ${res.status}). Try again in a minute.`);
  }

  const license = {
    key: cleanKey,
    activationId: res.json.id || null,
    status: 'granted',
    checkedAt: new Date().toISOString(),
    expiresAt: res.json.license_key?.expires_at || null,
  };
  writeConfig({ ...readConfig(env), license }, env);
  return licenseState({ license });
}

/*
 * Re-validate when due (or when forced). Network problems keep the stored
 * state, so the offline grace applies. Returns the resulting state.
 */
export async function refreshLicense({ force = false } = {}, env = process.env) {
  const config = readConfig(env);
  const license = config.license;
  if (!license?.key || license.status !== 'granted') return licenseState(config);

  const checked = license.checkedAt ? new Date(license.checkedAt).getTime() : 0;
  if (!force && Date.now() - checked < RECHECK_MS) return licenseState(config);

  try {
    const res = await post(env, '/v1/licenses/validate', {
      key: license.key, ...(license.activationId ? { activation_id: license.activationId } : {}),
    });
    if (res.status === 200 && res.json.status === 'granted') {
      license.checkedAt = new Date().toISOString();
      license.expiresAt = res.json.expires_at || null;
    } else if (res.status === 404) {
      license.status = 'revoked';
      license.checkedAt = new Date().toISOString();
    } else {
      return licenseState(config); // unexpected answer (429, 5xx): keep what we have
    }
    writeConfig({ ...config, license }, env);
  } catch {
    // offline or service down: grace period applies
  }
  return licenseState(readConfig(env));
}

export async function deactivateLicense(env = process.env) {
  const config = readConfig(env);
  const license = config.license;
  if (!license?.key) return false;
  if (license.activationId) {
    try {
      await post(env, '/v1/licenses/deactivate', { key: license.key, activation_id: license.activationId });
    } catch {
      // still remove locally
    }
  }
  const { license: _removed, ...rest } = config;
  writeConfig(rest, env);
  return true;
}

/*
 * For containers: activate from IMALI_LICENSE_KEY on start if this
 * machine doesn't hold that key yet (the activation is kept in IMALI_HOME).
 */
export async function ensureEnvLicense(env = process.env) {
  const key = env.IMALI_LICENSE_KEY;
  if (!key) return null;
  const current = readConfig(env).license;
  if (current?.key === key.trim().toUpperCase() && current.status === 'granted') return refreshLicense({}, env);
  return activateLicense(key, env);
}
