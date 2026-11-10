#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { VERSION, configDir, configFile, readConfig, writeConfig, resolveSettings, sha256 } from '../src/config.js';
import { activateLicense, deactivateLicense, refreshLicense, licenseState, proMessage, buyUrl } from '../src/license.js';

const CLI_PATH = fileURLToPath(import.meta.url);
const SERVER_PATH = fileURLToPath(new URL('../src/server.js', import.meta.url));
const SERVICE_LABEL = 'com.imali.commander';

const [command = 'help', ...rest] = process.argv.slice(2);
const flags = {};
for (let i = 0; i < rest.length; i++) {
  const arg = rest[i];
  if (!arg.startsWith('--')) { (flags._ ||= []).push(arg); continue; }
  const [key, inline] = arg.slice(2).split('=');
  if (inline !== undefined) flags[key] = inline;
  else if (rest[i + 1] && !rest[i + 1].startsWith('--')) flags[key] = rest[++i];
  else flags[key] = true;
}

const out = (...lines) => console.log(lines.join('\n'));
const err = message => { console.error(`imali-commander: ${message}`); process.exit(1); };
const newToken = () => randomBytes(32).toString('base64url');
const expandHome = p => (p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p);

function clientSnippets(settings, token) {
  const stdioEnv = process.env.IMALI_HOME ? { IMALI_HOME: configDir() } : undefined;
  const desktop = {
    mcpServers: {
      'imali-commander': { command: process.execPath, args: [SERVER_PATH], ...(stdioEnv ? { env: stdioEnv } : {}) },
    },
  };
  const lines = [
    '',
    'Desktop MCP clients (stdio) - add to the client\'s MCP config:',
    JSON.stringify(desktop, null, 2),
  ];
  if (token) {
    lines.push(
      '',
      'HTTP clients:',
      `  URL:    http://${settings.host}:${settings.port}/mcp`,
      `  Header: Authorization: Bearer ${token}`,
      '',
      'This token is shown once and stored only as a hash. Save it in your password manager.',
      'Lost it? Run: imali-commander rotate-token',
    );
  }
  return lines.join('\n');
}

function init() {
  const existing = readConfig();
  if (existing.tokenSha256 && !flags.force) {
    out(`Already set up (${configFile()}).`, 'Use --force to start over, or `imali-commander rotate-token` for a new token.');
    return;
  }
  const workspace = path.resolve(expandHome(String(flags.workspace || existing.workspace || path.join(os.homedir(), 'imali-workspace'))));
  fs.mkdirSync(workspace, { recursive: true });
  const token = newToken();
  const config = {
    ...existing,
    workspace,
    host: '127.0.0.1',
    port: Number(flags.port || existing.port || 8787),
    readOnly: Boolean(flags['read-only'] ?? existing.readOnly ?? false),
    tokenSha256: sha256(token),
    createdAt: existing.createdAt || new Date().toISOString(),
  };
  const file = writeConfig(config);
  out(
    `IMALI Commander ${VERSION} is set up.`,
    `  Config:    ${file}`,
    `  Workspace: ${workspace}${config.readOnly ? ' (read-only)' : ''}`,
    clientSnippets(resolveSettings(), token),
    '',
    'Next: `imali-commander start --http` (or `imali-commander service install --load` to run it in the background).',
  );
}

function rotateToken() {
  const config = readConfig();
  if (!config.workspace) err('Not set up yet. Run: imali-commander init');
  const token = newToken();
  writeConfig({ ...config, tokenSha256: sha256(token), rotatedAt: new Date().toISOString() });
  out('New token (old one stops working after a restart):', `  ${token}`, '', 'Restart Commander: imali-commander service restart  (or stop/start it yourself).');
}

async function start() {
  if (flags.http) process.env.IMALI_TRANSPORT = 'http';
  if (flags.workspace) process.env.IMALI_WORKSPACE = path.resolve(expandHome(String(flags.workspace)));
  if (flags.port) process.env.IMALI_PORT = String(flags.port);
  if (flags['read-only']) process.env.IMALI_READ_ONLY = '1';
  await import(SERVER_PATH);
}

async function health(settings) {
  try {
    const res = await fetch(`http://${settings.host === '0.0.0.0' ? '127.0.0.1' : settings.host}:${settings.port}/health`, { signal: AbortSignal.timeout(1500) });
    return res.ok ? await res.json() : null;
  } catch { return null; }
}

async function status() {
  const settings = resolveSettings();
  const running = await health(settings);
  const edition = licenseState(readConfig()).edition === 'pro' ? 'Pro' : 'Free';
  out(
    `IMALI Commander ${VERSION} (${edition})`,
    `  Config:     ${fs.existsSync(configFile()) ? configFile() : 'not set up (run imali-commander init)'}`,
    `  Workspace:  ${settings.workspace}`,
    `  Mode:       ${settings.readOnly ? 'read-only' : 'read/write'}`,
    `  Token:      ${settings.token ? 'from IMALI_MCP_TOKEN' : settings.tokenSha256 ? 'configured (hashed)' : 'missing'}`,
    `  HTTP:       http://${settings.host}:${settings.port}/mcp ${running ? `- running, ${running.sessions} session(s)` : '- not running'}`,
    `  Audit log:  ${settings.auditLog}`,
  );
}

function portFree(port, host) {
  return new Promise(resolve => {
    const srv = net.createServer().once('error', () => resolve(false)).once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, host);
  });
}

async function doctor() {
  const settings = resolveSettings();
  const checks = [];
  const check = (ok, label, hint = '') => checks.push({ ok, label, hint });

  const major = Number(process.versions.node.split('.')[0]);
  check(major >= 20, `Node.js ${process.versions.node}`, 'Install Node.js 20 or newer');

  const cfgPath = configFile();
  if (fs.existsSync(cfgPath)) {
    const mode = fs.statSync(cfgPath).mode & 0o777;
    check((mode & 0o077) === 0, `Config permissions ${mode.toString(8)}`, `chmod 600 ${cfgPath}`);
  } else {
    check(false, 'Config file', 'Run: imali-commander init');
  }

  try {
    fs.mkdirSync(settings.workspace, { recursive: true });
    fs.accessSync(settings.workspace, fs.constants.R_OK | fs.constants.W_OK);
    check(true, `Workspace ${settings.workspace}`);
  } catch {
    check(false, `Workspace ${settings.workspace}`, 'Pick a folder you own: imali-commander init --force --workspace <path>');
  }
  check(settings.workspace !== os.homedir() && settings.workspace !== '/', 'Workspace is not your whole home folder', 'Use a dedicated folder');

  let gitOk = false;
  try { execFileSync('git', ['--version'], { stdio: 'ignore' }); gitOk = true; } catch {}
  check(gitOk, 'git available (for git-* commands)', 'Optional: install git');

  check(Boolean(settings.token || settings.tokenSha256), 'Access token configured', 'Run: imali-commander init');

  const running = await health(settings);
  const free = running ? true : await portFree(settings.port, settings.host);
  check(free, running ? `Port ${settings.port} (Commander running)` : `Port ${settings.port} free`, 'Choose another: imali-commander init --force --port <n>');

  for (const c of checks) out(`${c.ok ? '✔' : '✖'} ${c.label}${c.ok || !c.hint ? '' : `  → ${c.hint}`}`);
  process.exitCode = checks.some(c => !c.ok && !c.label.startsWith('git')) ? 1 : 0;
}

function launchdPlist() {
  const logs = path.join(configDir(), 'logs');
  fs.mkdirSync(logs, { recursive: true, mode: 0o700 });
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${SERVICE_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${esc(process.execPath)}</string>
    <string>${esc(CLI_PATH)}</string>
    <string>start</string>
    <string>--http</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict><key>IMALI_HOME</key><string>${esc(configDir())}</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${esc(path.join(logs, 'service.log'))}</string>
  <key>StandardErrorPath</key><string>${esc(path.join(logs, 'service.log'))}</string>
</dict>
</plist>
`;
}

function systemdUnit() {
  return `[Unit]
Description=IMALI Commander MCP server
After=network.target

[Service]
ExecStart=${process.execPath} ${CLI_PATH} start --http
Environment=IMALI_HOME=${configDir()}
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=default.target
`;
}

function servicePaths() {
  if (process.platform === 'darwin') return { file: path.join(os.homedir(), 'Library', 'LaunchAgents', `${SERVICE_LABEL}.plist`), kind: 'launchd' };
  if (process.platform === 'linux') return { file: path.join(os.homedir(), '.config', 'systemd', 'user', 'imali-commander.service'), kind: 'systemd' };
  return null;
}

function run(cmd, args, { quiet = false } = {}) {
  try { execFileSync(cmd, args, { stdio: quiet ? 'ignore' : 'inherit' }); return true; } catch { return false; }
}

function service() {
  const action = flags._?.[0] || 'help';
  const target = servicePaths();
  if (!target) err('Background service is supported on macOS (launchd) and Linux (systemd). On Windows run `imali-commander start --http` from Task Scheduler.');
  const uid = process.getuid?.();

  if (action === 'install') {
    if (!resolveSettings().tokenSha256 && !process.env.IMALI_MCP_TOKEN) err('Run `imali-commander init` first.');
    fs.mkdirSync(path.dirname(target.file), { recursive: true });
    fs.writeFileSync(target.file, target.kind === 'launchd' ? launchdPlist() : systemdUnit());
    out(`Wrote ${target.file}`);
    if (flags.load) {
      if (target.kind === 'launchd') {
        // Unload any previous copy first; failing because none was loaded is normal.
        run('launchctl', ['bootout', `gui/${uid}`, target.file], { quiet: true });
        if (!run('launchctl', ['bootstrap', `gui/${uid}`, target.file])) err('launchctl could not load the service');
      } else if (!run('systemctl', ['--user', 'daemon-reload']) || !run('systemctl', ['--user', 'enable', '--now', 'imali-commander'])) {
        err('systemctl could not start the service');
      }
      out('Service started. Check it with: imali-commander status');
    } else {
      out(target.kind === 'launchd'
        ? `Start it with: launchctl bootstrap gui/${uid} ${target.file}   (or re-run with --load)`
        : 'Start it with: systemctl --user daemon-reload && systemctl --user enable --now imali-commander   (or re-run with --load)');
    }
    return;
  }

  if (action === 'restart') {
    const ok = target.kind === 'launchd'
      ? run('launchctl', ['kickstart', '-k', `gui/${uid}/${SERVICE_LABEL}`])
      : run('systemctl', ['--user', 'restart', 'imali-commander']);
    if (!ok) err('Restart failed. Is the service installed? Run: imali-commander service install --load');
    out('Restarted.');
    return;
  }

  if (action === 'uninstall') {
    if (target.kind === 'launchd') run('launchctl', ['bootout', `gui/${uid}`, target.file], { quiet: true });
    else run('systemctl', ['--user', 'disable', '--now', 'imali-commander']);
    try { fs.unlinkSync(target.file); out(`Removed ${target.file}`); } catch { out('Service was not installed.'); }
    return;
  }

  out('Usage: imali-commander service install [--load] | restart | uninstall');
}

async function activate() {
  const key = flags._?.[0];
  if (!key) err('Usage: imali-commander activate <license-key>');
  const state = await activateLicense(key);
  out(
    'IMALI Commander Pro is active on this machine.',
    `  License: ${state.key}`,
    state.expiresAt ? `  Valid until: ${state.expiresAt}` : '  Renews with your subscription.',
    '',
    'Restart Commander to turn on Pro features: imali-commander service restart',
  );
}

async function deactivate() {
  if (!(await deactivateLicense())) {
    out('No license is active on this machine.');
    return;
  }
  out('License removed from this machine (its seat is free for another one). Restart Commander to apply.');
}

async function license() {
  const state = flags.check ? await refreshLicense({ force: true }) : licenseState(readConfig());
  const url = buyUrl();
  out(
    `Edition: ${state.edition === 'pro' ? 'Pro' : 'Free'}`,
    ...(state.key ? [`  License:      ${state.key}`] : []),
    ...(state.checkedAt ? [`  Last checked: ${state.checkedAt}`] : []),
    ...(state.expiresAt ? [`  Expires:      ${state.expiresAt}`] : []),
    ...(state.reason ? [`  Note:         ${state.reason}`] : []),
    ...(state.edition !== 'pro' ? ['', 'Pro adds remote HTTPS access (ChatGPT and other web assistants) and multiple workspaces.', url ? `Get it at ${url}` : 'Activate with: imali-commander activate <license-key>'] : []),
  );
}

const WORKSPACE_NAME = /^[A-Za-z0-9_-]{1,32}$/;

function workspace() {
  const action = flags._?.[0] || 'list';
  const config = readConfig();
  const extra = { ...(config.workspaces || {}) };

  if (action === 'list') {
    const settings = resolveSettings();
    out(`main  ${settings.workspace}  (default)`);
    for (const [name, dir] of Object.entries(extra)) out(`${name}  ${dir}`);
    if (Object.keys(extra).length && licenseState(config).edition !== 'pro') out('', proMessage('Using extra workspaces'));
    return;
  }

  if (action === 'add') {
    const [, name, dir] = flags._;
    if (!name || !dir) err('Usage: imali-commander workspace add <name> <folder>');
    if (!WORKSPACE_NAME.test(name) || name === 'main') err('Workspace names use letters, numbers, - and _ (and "main" is taken).');
    if (licenseState(config).edition !== 'pro') err(proMessage('Multiple workspaces'));
    const full = path.resolve(expandHome(dir));
    if (full === os.homedir() || full === '/') err('Pick a dedicated folder, not your whole home folder or /.');
    fs.mkdirSync(full, { recursive: true });
    extra[name] = full;
    writeConfig({ ...config, workspaces: extra });
    out(`Added workspace "${name}" → ${full}`, 'Restart Commander to use it: imali-commander service restart');
    return;
  }

  if (action === 'remove') {
    const name = flags._[1];
    if (!name || !extra[name]) err(`No workspace named "${name || ''}". See: imali-commander workspace list`);
    delete extra[name];
    writeConfig({ ...config, workspaces: extra });
    out(`Removed workspace "${name}" (files were not touched). Restart Commander to apply.`);
    return;
  }

  out('Usage: imali-commander workspace list | add <name> <folder> | remove <name>');
}

function help() {
  out(
    `IMALI Commander ${VERSION} - give AI assistants safe, scoped access to one folder.`,
    '',
    'Usage: imali-commander <command> [options]',
    '',
    '  init [--workspace <dir>] [--port <n>] [--read-only] [--force]   set up and get your access token',
    '  start [--http] [--workspace <dir>] [--port <n>] [--read-only]   run the server (stdio by default)',
    '  status                                                          show settings and whether it is running',
    '  doctor                                                          check the install for problems',
    '  rotate-token                                                    issue a new access token',
    '  service install [--load] | restart | uninstall                  run in the background (macOS/Linux)',
    '',
    'Pro:',
    '  activate <license-key>                                          turn on Pro on this machine',
    '  license [--check]                                               show edition (--check re-validates now)',
    '  deactivate                                                      free this machine\'s license seat',
    '  workspace list | add <name> <folder> | remove <name>            extra workspaces (Pro)',
    '',
    '  version',
    '',
    `Config: ${configFile()}  (override the folder with IMALI_HOME)`,
  );
}

const commands = {
  init, start, status, doctor, service, help, activate, deactivate, license, workspace,
  'rotate-token': rotateToken,
  version: () => out(VERSION),
  '--version': () => out(VERSION),
  '-v': () => out(VERSION),
  '--help': help,
  '-h': help,
};

const handler = commands[command];
if (!handler) {
  console.error(`Unknown command: ${command}\n`);
  help();
  process.exit(1);
}
try {
  await handler();
} catch (e) {
  err(e.message);
}
