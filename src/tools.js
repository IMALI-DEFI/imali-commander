import { z } from 'zod';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';

export const MAX_TEXT = 1024 * 1024;
export const MAX_BINARY = 5 * 1024 * 1024;

const result = text => ({ content: [{ type: 'text', text: String(text) }] });
const failure = e => ({ content: [{ type: 'text', text: 'Error: ' + (e?.message || e) }], isError: true });

const GIT = ['/usr/bin/git', '/opt/homebrew/bin/git', '/usr/local/bin/git'].find(p => existsSync(p)) || 'git';
const BIN = {
  pwd: ['/bin/pwd', '/usr/bin/pwd'].find(p => existsSync(p)) || 'pwd',
  ls: ['/bin/ls', '/usr/bin/ls'].find(p => existsSync(p)) || 'ls',
};

export function createPathGuard(root) {
  const inside = p => p === root || p.startsWith(root + path.sep);
  return async function safePath(relative) {
    const target = path.resolve(root, relative);
    if (!inside(target)) throw new Error('Outside allowed workspace');
    const existing = await fs.realpath(target).catch(() => null);
    if (existing && !inside(existing)) throw new Error('Symlink outside workspace');
    let parent = path.dirname(target);
    while (inside(parent)) {
      const real = await fs.realpath(parent).catch(() => null);
      if (real && !inside(real)) throw new Error('Parent symlink outside workspace');
      if (parent === root) break;
      parent = path.dirname(parent);
    }
    return target;
  };
}

/*
 * Registers the Commander tools on an MCP server.
 *   roots     { name: realpath } of approved workspaces; the first is the default
 *             (legacy: `root` = single workspace path)
 *   readOnly  leave out write_file, upload_file and create_directory
 *   audit     function(entry) from createAuditLog
 *   session   label recorded in the audit log
 *
 * With one workspace the tool schemas are exactly as before. With several
 * (Pro), every tool gets an optional `workspace` argument.
 */
export function registerTools(server, { root, roots, readOnly = false, audit = () => {}, session = 'stdio', version = '' }) {
  const workspaces = roots && Object.keys(roots).length ? roots : { main: root };
  const names = Object.keys(workspaces);
  const defaultName = names[0];
  const guards = Object.fromEntries(names.map(n => [n, createPathGuard(workspaces[n])]));
  const multi = names.length > 1;
  const workspaceArg = multi
    ? { workspace: z.string().optional().describe(`Workspace to use: ${names.join(', ')} (default ${defaultName})`) }
    : {};

  const contextFor = args => {
    const name = args?.workspace || defaultName;
    if (!guards[name]) throw new Error(`Unknown workspace "${name}". Available: ${names.join(', ')}`);
    return { name, root: workspaces[name], safePath: guards[name] };
  };

  const define = (name, description, schema, handler, { writes = false } = {}) => {
    if (writes && readOnly) return;
    server.tool(name, description, { ...schema, ...workspaceArg }, async args => {
      const started = Date.now();
      let response;
      let workspace = null;
      try {
        const ctx = contextFor(args);
        workspace = ctx.name;
        response = await handler(args, ctx);
      } catch (e) {
        response = failure(e);
      }
      audit({
        session,
        tool: name,
        ...(multi ? { workspace } : {}),
        target: args?.file ?? args?.directory ?? args?.command ?? null,
        bytes: typeof args?.content === 'string' ? args.content.length : typeof args?.data === 'string' ? args.data.length : undefined,
        ok: !response.isError,
        error: response.isError ? response.content?.[0]?.text?.slice(0, 200) : undefined,
        ms: Date.now() - started,
      });
      return response;
    });
  };

  define('device_info', 'Describe connected local computer and workspace', {}, async (_args, ctx) =>
    result(JSON.stringify({ platform: process.platform, hostname: os.hostname(), workspace: ctx.root, version, readOnly, ...(multi ? { workspaces: names, current: ctx.name } : {}) })));

  define('list_files', 'List files within approved workspace', { directory: z.string().default('.') }, async ({ directory }, ctx) => {
    const p = await ctx.safePath(directory);
    const files = await fs.readdir(p, { withFileTypes: true });
    return result(JSON.stringify(files.map(f => ({ name: f.name, type: f.isDirectory() ? 'directory' : f.isSymbolicLink() ? 'symlink' : 'file' }))));
  });

  define('read_file', 'Read UTF-8 file in workspace (up to 1 MB)', { file: z.string() }, async ({ file }, ctx) => {
    const p = await ctx.safePath(file);
    const stat = await fs.stat(p);
    if (!stat.isFile()) throw new Error('Not a regular file');
    if (stat.size > MAX_TEXT) throw new Error('File exceeds 1 MB');
    return result(await fs.readFile(p, 'utf8'));
  });

  define('write_file', 'Create or replace UTF-8 file in workspace', { file: z.string(), content: z.string().max(MAX_TEXT) }, async ({ file, content }, ctx) => {
    const p = await ctx.safePath(file);
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, content, { flag: 'w' });
    return result(`Wrote ${file}`);
  }, { writes: true });

  define('download_file', 'Read a small workspace file as base64 for transfer to an MCP client (max 5 MB)', { file: z.string() }, async ({ file }, ctx) => {
    const p = await ctx.safePath(file);
    const st = await fs.lstat(p);
    if (!st.isFile() || st.size > MAX_BINARY) throw new Error('Not a regular file or exceeds 5 MB');
    const bytes = await fs.readFile(p);
    return result(JSON.stringify({ name: path.basename(p), size: bytes.length, encoding: 'base64', data: bytes.toString('base64') }));
  });

  define('upload_file', 'Write base64-encoded file into approved workspace (max 5 MB)', { file: z.string(), data: z.string().max(7 * 1024 * 1024) }, async ({ file, data }, ctx) => {
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)) throw new Error('Invalid base64');
    const bytes = Buffer.from(data, 'base64');
    if (bytes.length > MAX_BINARY) throw new Error('Exceeds 5 MB');
    const p = await ctx.safePath(file);
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, bytes, { flag: 'w' });
    return result(JSON.stringify({ written: path.relative(ctx.root, p), bytes: bytes.length }));
  }, { writes: true });

  define('create_directory', 'Create a directory within approved workspace', { directory: z.string() }, async ({ directory }, ctx) => {
    const p = await ctx.safePath(directory);
    await fs.mkdir(p, { recursive: true });
    return result('Created ' + directory);
  }, { writes: true });

  define('file_info', 'Show metadata for a file or directory in the workspace', { file: z.string() }, async ({ file }, ctx) => {
    const p = await ctx.safePath(file);
    const st = await fs.lstat(p);
    return result(JSON.stringify({ name: path.basename(p), bytes: st.size, directory: st.isDirectory(), symlink: st.isSymbolicLink(), modified: st.mtime.toISOString() }));
  });

  define('search_files', 'Search filenames recursively within the workspace', { directory: z.string().default('.'), query: z.string().min(1).max(100) }, async ({ directory, query }, ctx) => {
    const base = await ctx.safePath(directory), matches = [], pending = [base];
    const needle = query.toLowerCase();
    let visited = 0;
    while (pending.length && visited < 3000 && matches.length < 100) {
      const dir = pending.shift(); visited++;
      const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const ent of entries) {
        const full = path.join(dir, ent.name);
        if (ent.name.toLowerCase().includes(needle)) matches.push(path.relative(ctx.root, full));
        if (ent.isDirectory() && !ent.isSymbolicLink() && ent.name !== 'node_modules' && ent.name !== '.git') pending.push(full);
      }
    }
    return result(JSON.stringify({ matches, limited: pending.length > 0 || matches.length >= 100 }));
  });

  define('run_workspace_command', 'Run a limited read-only command in the workspace; no shell or arbitrary programs', {
    command: z.enum(['pwd', 'ls', 'git-status', 'git-diff', 'git-log']),
    directory: z.string().default('.'),
  }, async ({ command, directory }, ctx) => {
    const cwd = await ctx.safePath(directory);
    const commands = {
      pwd: [BIN.pwd, []],
      ls: [BIN.ls, ['-la']],
      'git-status': [GIT, ['status', '--short']],
      'git-diff': [GIT, ['diff', '--stat']],
      'git-log': [GIT, ['log', '-5', '--oneline']],
    };
    const [exe, args] = commands[command];
    return await new Promise(resolve => {
      const proc = spawn(exe, args, {
        cwd,
        env: { PATH: '/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin', GIT_PAGER: 'cat', GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '';
      const timer = setTimeout(() => proc.kill('SIGKILL'), 5000);
      for (const stream of [proc.stdout, proc.stderr]) stream.on('data', chunk => {
        output += chunk.toString().slice(0, 32768 - output.length);
        if (output.length >= 32768) proc.kill('SIGKILL');
      });
      proc.on('error', e => { clearTimeout(timer); resolve(failure(e)); });
      proc.on('close', code => { clearTimeout(timer); resolve(result(JSON.stringify({ exitCode: code, output }))); });
    });
  });
}
