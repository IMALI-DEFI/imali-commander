import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { setTimeout as wait } from 'node:timers/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

test('symlink escapes are blocked and errors are flagged', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'imali-sym-'));
  const outside = await mkdtemp(path.join(os.tmpdir(), 'imali-out-'));
  await writeFile(path.join(outside, 'secret.txt'), 'secret');
  await symlink(outside, path.join(root, 'link'));
  const client = new Client({ name: 'imali-tests', version: '1.0' });
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath, args: ['src/server.js'], env: { ...process.env, IMALI_WORKSPACE: root, IMALI_HOME: root + '-home', IMALI_AUDIT_LOG: 'off' } }));
    const read = await client.callTool({ name: 'read_file', arguments: { file: 'link/secret.txt' } });
    assert.equal(read.isError, true);
    assert.match(read.content[0].text, /outside workspace/i);
    const write = await client.callTool({ name: 'write_file', arguments: { file: 'link/new.txt', content: 'x' } });
    assert.equal(write.isError, true);
    const ok = await client.callTool({ name: 'write_file', arguments: { file: 'ok.txt', content: 'x' } });
    assert.notEqual(ok.isError, true);
  } finally {
    await client.close();
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('HTTP transport: auth, health and concurrent sessions', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'imali-http-'));
  const token = randomBytes(32).toString('hex');
  const port = 8800 + Math.floor(Math.random() * 500);
  const proc = spawn(process.execPath, ['src/server.js'], {
    env: { ...process.env, IMALI_TRANSPORT: 'http', IMALI_PORT: String(port), IMALI_MCP_TOKEN: token, IMALI_WORKSPACE: root, IMALI_HOME: root + '-home', IMALI_AUDIT_LOG: 'off' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  t.after(async () => { proc.kill(); await rm(root, { recursive: true, force: true }); });

  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`${base}/health`)).ok) break; } catch {}
    await wait(100);
  }

  const health = await (await fetch(`${base}/health`)).json();
  assert.equal(health.status, 'ok');

  const denied = await fetch(`${base}/mcp`, { method: 'POST', headers: { Authorization: 'Bearer wrong' }, body: '{}' });
  assert.equal(denied.status, 401);

  const connect = async () => {
    const client = new Client({ name: 'imali-http-test', version: '1.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }));
    return client;
  };

  const a = await connect();
  const b = await connect();
  try {
    assert.equal((await a.listTools()).tools.length, 10);
    assert.equal((await b.listTools()).tools.length, 10);
    await a.callTool({ name: 'write_file', arguments: { file: 'from-a.txt', content: 'hello' } });
    const read = await b.callTool({ name: 'read_file', arguments: { file: 'from-a.txt' } });
    assert.equal(read.content[0].text, 'hello');
  } finally {
    await a.close();
    await b.close();
  }
});
