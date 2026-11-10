import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

export function configDir(env = process.env) {
  return path.resolve(env.IMALI_HOME || path.join(os.homedir(), '.imali-commander'));
}

export function configFile(env = process.env) {
  return path.join(configDir(env), 'config.json');
}

export function readConfig(env = process.env) {
  try {
    return JSON.parse(fs.readFileSync(configFile(env), 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return {};
    throw new Error(`Could not read ${configFile(env)}: ${e.message}`);
  }
}

export function writeConfig(config, env = process.env) {
  const dir = configDir(env);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = configFile(env);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
  fs.chmodSync(file, 0o600);
  return file;
}

export const sha256 = value => createHash('sha256').update(String(value)).digest('hex');

const truthy = value => value === true || /^(1|true|yes|on)$/i.test(String(value ?? ''));

/*
 * Settings come from (highest first): environment variables, the config
 * file written by `imali-commander init`, then defaults. Plain
 * `node src/server.js` with env vars keeps working exactly as before.
 */
export function resolveSettings(env = process.env) {
  const cfg = readConfig(env);
  const pick = (envKey, cfgKey, fallback) => env[envKey] ?? cfg[cfgKey] ?? fallback;
  return {
    workspace: path.resolve(pick('IMALI_WORKSPACE', 'workspace', path.join(os.homedir(), 'imali-workspace'))),
    transport: env.IMALI_TRANSPORT === 'http' ? 'http' : 'stdio',
    host: pick('IMALI_HOST', 'host', '127.0.0.1'),
    port: Number(pick('IMALI_PORT', 'port', 8787)),
    token: env.IMALI_MCP_TOKEN || null,
    tokenSha256: pick('IMALI_MCP_TOKEN_SHA256', 'tokenSha256', null),
    readOnly: truthy(pick('IMALI_READ_ONLY', 'readOnly', false)),
    allowRemote: truthy(pick('IMALI_ALLOW_REMOTE', 'allowRemote', false)),
    trustProxy: truthy(pick('IMALI_TRUST_PROXY', 'trustProxy', false)),
    maxSessions: Number(pick('IMALI_MAX_SESSIONS', 'maxSessions', 16)),
    auditLog: pick('IMALI_AUDIT_LOG', 'auditLog', path.join(configDir(env), 'logs', 'audit.log')),
    // Pro: extra named workspaces { name: absolutePath }; the main one is always "main".
    extraWorkspaces: cfg.workspaces && typeof cfg.workspaces === 'object' ? cfg.workspaces : {},
  };
}
