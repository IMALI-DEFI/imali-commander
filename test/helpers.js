import { mkdtemp } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { setTimeout as wait } from 'node:timers/promises';
import os from 'node:os';
import path from 'node:path';

export const tmp = prefix => mkdtemp(path.join(os.tmpdir(), prefix));

// Every test gets its own IMALI_HOME so a real ~/.imali-commander is never touched.
export async function isolatedEnv(extra = {}) {
  const home = await tmp('imali-home-');
  return { ...process.env, IMALI_HOME: home, IMALI_AUDIT_LOG: path.join(home, 'audit.log'), ...extra };
}

export function runCli(args, env) {
  return new Promise(resolve => {
    const proc = spawn(process.execPath, ['bin/imali-commander.js', ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    proc.stdout.on('data', c => (stdout += c));
    proc.stderr.on('data', c => (stderr += c));
    proc.on('close', code => resolve({ code, stdout, stderr }));
  });
}

export async function startHttpServer(env) {
  const port = 9000 + Math.floor(Math.random() * 900);
  const proc = spawn(process.execPath, ['src/server.js'], {
    env: { ...env, IMALI_TRANSPORT: 'http', IMALI_PORT: String(port) },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  proc.stderr.on('data', c => (stderr += c));
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 60; i++) {
    if (proc.exitCode !== null) throw new Error(`server exited: ${stderr}`);
    try { if ((await fetch(`${base}/health`)).ok) return { proc, base }; } catch {}
    await wait(100);
  }
  proc.kill();
  throw new Error(`server did not start: ${stderr}`);
}
