/*
 * Support lookups on the server:
 *   node scripts/admin.js find <email-or-key>
 *   node scripts/admin.js recent [count]
 * Uses DB_PATH (default ./data/licenses.db).
 */
import { openDb } from '../src/db.js';

const db = openDb(process.env.DB_PATH || './data/licenses.db');
const [cmd, arg] = process.argv.slice(2);
const fmt = t => (t ? new Date(t).toISOString().slice(0, 16).replace('T', ' ') : '-');

function show(rows) {
  if (!rows.length) return console.log('No licenses found.');
  for (const l of rows) {
    const acts = db.prepare('SELECT label, created_at, last_validated_at FROM activations WHERE license_key = ? AND deactivated_at IS NULL').all(l.key);
    console.log(`${l.key}  ${l.status.padEnd(9)} ${String(l.plan || '-').padEnd(8)} ${l.email || '-'}  created ${fmt(l.created_at)}`);
    for (const a of acts) console.log(`    machine: ${a.label || '-'}  since ${fmt(a.created_at)}  last check ${fmt(a.last_validated_at)}`);
  }
}

if (cmd === 'find' && arg) {
  show(db.prepare('SELECT * FROM licenses WHERE lower(email) = lower(?) OR key = upper(?) ORDER BY created_at DESC').all(arg, arg));
} else if (cmd === 'recent') {
  show(db.prepare('SELECT * FROM licenses ORDER BY created_at DESC LIMIT ?').all(Number(arg) || 20));
} else {
  console.log('Usage: node scripts/admin.js find <email-or-key> | recent [count]');
}
