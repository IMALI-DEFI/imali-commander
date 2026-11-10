import fs from 'node:fs';
import path from 'node:path';

const MAX_BYTES = 10 * 1024 * 1024;

/*
 * JSON-lines audit log of every tool call: what was touched, how big,
 * whether it worked. File contents and tokens are never written.
 * Rotates to audit.log.1 at 10 MB. Set the path to "off" to disable.
 */
export function createAuditLog(file) {
  if (!file || file === 'off') return () => {};

  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  } catch {
    return () => {};
  }

  return entry => {
    try {
      const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n';
      try {
        if (fs.statSync(file).size + line.length > MAX_BYTES) fs.renameSync(file, `${file}.1`);
      } catch {}
      fs.appendFileSync(file, line, { mode: 0o600 });
    } catch {
      // Auditing must never take the server down.
    }
  };
}
