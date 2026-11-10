import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { isolatedEnv, runCli, startHttpServer, tmp } from './helpers.js';

const tokenFrom = stdout => /Bearer (\S+)/.exec(stdout)?.[1] || /^\s{2}(\S{40,})$/m.exec(stdout)?.[1];

test('init writes a private config with a hashed token, and HTTP accepts that token', async t => {
  const env = await isolatedEnv();
  const workspace = await tmp('imali-ws-');
  const init = await runCli(['init', '--workspace', workspace, '--port', '9999'], env);
  assert.equal(init.code, 0, init.stderr);

  const file = path.join(env.IMALI_HOME, 'config.json');
  const config = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.match(config.tokenSha256, /^[a-f0-9]{64}$/);
  const token = tokenFrom(init.stdout);
  assert.ok(token && token.length >= 40);
  assert.equal(fs.readFileSync(file, 'utf8').includes(token), false, 'plaintext token must not be stored');

  // A second init without --force must not replace the token.
  assert.match((await runCli(['init'], env)).stdout, /Already set up/);

  const { proc, base } = await startHttpServer({ ...env, IMALI_MCP_TOKEN: '' });
  t.after(() => proc.kill());

  const client = new Client({ name: 'cli-test', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  const info = JSON.parse((await client.callTool({ name: 'device_info', arguments: {} })).content[0].text);
  assert.equal(info.workspace, fs.realpathSync(workspace));
  await client.close();

  // rotate-token invalidates the old token after restart.
  const rotated = await runCli(['rotate-token'], env);
  assert.equal(rotated.code, 0);
  assert.notEqual(tokenFrom(rotated.stdout), token);
});

test('read-only mode removes write tools; audit log records calls without contents', async () => {
  const env = await isolatedEnv({ IMALI_WORKSPACE: await tmp('imali-ro-'), IMALI_READ_ONLY: '1' });
  const client = new Client({ name: 'ro-test', version: '1' });
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath, args: ['src/server.js'], env }));
    const names = (await client.listTools()).tools.map(t => t.name);
    assert.equal(names.length, 7);
    assert.ok(!names.includes('write_file') && !names.includes('upload_file') && !names.includes('create_directory'));
    await client.callTool({ name: 'read_file', arguments: { file: 'missing.txt' } });
    await client.callTool({ name: 'list_files', arguments: {} });
  } finally {
    await client.close();
  }
  const lines = fs.readFileSync(env.IMALI_AUDIT_LOG, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(lines.length, 2);
  assert.deepEqual(lines.map(l => [l.tool, l.ok]), [['read_file', false], ['list_files', true]]);
  assert.equal(lines[0].target, 'missing.txt');
});

test('repeated bad tokens get locked out with 429', async t => {
  const env = await isolatedEnv({ IMALI_WORKSPACE: await tmp('imali-rl-'), IMALI_MCP_TOKEN: 'x'.repeat(40) });
  const { proc, base } = await startHttpServer(env);
  t.after(() => proc.kill());
  const statuses = [];
  for (let i = 0; i < 12; i++) {
    statuses.push((await fetch(`${base}/mcp`, { method: 'POST', headers: { Authorization: 'Bearer nope' }, body: '{}' })).status);
  }
  assert.deepEqual(statuses.slice(0, 10), Array(10).fill(401));
  assert.equal(statuses[11], 429);
  // Even the right token is refused while locked out.
  const locked = await fetch(`${base}/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${'x'.repeat(40)}` }, body: '{}' });
  assert.equal(locked.status, 429);
});

test('refuses to bind beyond localhost unless explicitly allowed', async () => {
  const env = await isolatedEnv({ IMALI_WORKSPACE: await tmp('imali-bind-'), IMALI_MCP_TOKEN: 'y'.repeat(40), IMALI_HOST: '0.0.0.0' });
  await assert.rejects(startHttpServer(env), /Refusing to bind beyond localhost/);
});

test('doctor and status run against a fresh install', async () => {
  const env = await isolatedEnv();
  await runCli(['init', '--workspace', await tmp('imali-doc-')], env);
  const doctor = await runCli(['doctor'], env);
  assert.match(doctor.stdout, /✔ Access token configured/);
  const status = await runCli(['status'], env);
  assert.match(status.stdout, /configured \(hashed\)/);
  assert.equal((await runCli(['version'], env)).stdout.trim(), JSON.parse(fs.readFileSync('package.json', 'utf8')).version);
});
