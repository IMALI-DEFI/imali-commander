#!/usr/bin/env node
/*
 * IMALI Commander MCP server entry point.
 *
 *   node src/server.js                       stdio (desktop MCP clients)
 *   IMALI_TRANSPORT=http node src/server.js  authenticated Streamable HTTP
 *
 * The `imali-commander` CLI (bin/) wraps this with a config file; env vars
 * always win, so existing client configs keep working unchanged.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { VERSION, readConfig, resolveSettings } from './config.js';
import { createAuditLog } from './audit.js';
import { registerTools } from './tools.js';
import { startHttp } from './http.js';
import { ensureEnvLicense, refreshLicense, licenseState, proMessage } from './license.js';

const settings = resolveSettings();
await fs.mkdir(settings.workspace, { recursive: true });
const audit = createAuditLog(settings.auditLog);

// License: Free never touches the network; Pro re-validates at most daily.
try {
  if (process.env.IMALI_LICENSE_KEY) await ensureEnvLicense();
  else await refreshLicense();
} catch (e) {
  console.error(`IMALI Commander: license check failed: ${e.message}`);
}
const license = licenseState(readConfig());
const pro = license.edition === 'pro';

const roots = { main: await fs.realpath(settings.workspace) };
const extras = Object.entries(settings.extraWorkspaces);
if (extras.length && !pro) {
  console.error(`IMALI Commander: ${extras.length} extra workspace(s) configured but not loaded. ${proMessage('Multiple workspaces')}`);
} else {
  for (const [name, dir] of extras) {
    try {
      roots[name] = await fs.realpath(path.resolve(dir));
    } catch {
      console.error(`IMALI Commander: workspace "${name}" (${dir}) not found, skipping`);
    }
  }
}

function createServer(session = settings.transport) {
  const server = new McpServer({ name: 'imali-commander', version: VERSION });
  registerTools(server, { roots, readOnly: settings.readOnly, audit, session, version: VERSION });
  return server;
}

try {
  if (settings.transport === 'http') {
    const http = await startHttp(settings, { createServer, audit, version: VERSION, pro });
    // Keep the license fresh on long-running servers (takes effect on next restart).
    setInterval(() => {
      refreshLicense().then(state => {
        if (pro && state.edition !== 'pro') console.error(`IMALI Commander: Pro license no longer valid (${state.reason}). Pro features turn off at next restart.`);
      }).catch(() => {});
    }, 6 * 60 * 60 * 1000).unref();
    void http;
  } else {
    await createServer('stdio').connect(new StdioServerTransport());
  }
} catch (e) {
  console.error(`IMALI Commander: ${e.message}`);
  process.exit(1);
}
