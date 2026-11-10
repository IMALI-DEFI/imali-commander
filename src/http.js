import http from 'node:http';
import { randomUUID, timingSafeEqual, createHash } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { proMessage } from './license.js';

const MAX_HTTP_BODY = 8 * 1024 * 1024; // a 5 MB upload as base64 plus JSON-RPC framing
const AUTH_FAILURE_LIMIT = 10;          // per client per minute, then locked out for the rest of it
const REQUEST_LIMIT = 600;              // per client per minute
const WINDOW_MS = 60 * 1000;
const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

const digest = value => createHash('sha256').update(String(value)).digest();

function makeAuthorizer({ token, tokenSha256 }) {
  if (token) {
    if (token.length < 32) throw new Error('IMALI_MCP_TOKEN must be at least 32 characters');
    const expected = digest(token);
    return supplied => timingSafeEqual(digest(supplied), expected);
  }
  if (tokenSha256) {
    if (!/^[a-f0-9]{64}$/i.test(tokenSha256)) throw new Error('tokenSha256 must be a 64-character hex SHA-256');
    const expected = Buffer.from(tokenSha256, 'hex');
    return supplied => timingSafeEqual(digest(supplied), expected);
  }
  throw new Error('No access token configured. Run `imali-commander init` or set IMALI_MCP_TOKEN (32+ chars).');
}

function makeLimiter() {
  const clients = new Map();
  const entry = ip => {
    const now = Date.now();
    let e = clients.get(ip);
    if (!e || now > e.resetAt) {
      e = { requests: 0, failures: 0, resetAt: now + WINDOW_MS };
      clients.set(ip, e);
      if (clients.size > 10000) clients.delete(clients.keys().next().value);
    }
    return e;
  };
  return {
    blocked: ip => {
      const e = entry(ip);
      e.requests++;
      return e.failures >= AUTH_FAILURE_LIMIT || e.requests > REQUEST_LIMIT;
    },
    fail: ip => { entry(ip).failures++; },
    retryAfter: ip => Math.max(1, Math.ceil((entry(ip).resetAt - Date.now()) / 1000)),
  };
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_HTTP_BODY) { reject(Object.assign(new Error('Payload too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!size) return resolve(undefined);
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(Object.assign(new Error('Invalid JSON'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, body, headers = {}) {
  if (res.headersSent) return;
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers }).end(JSON.stringify(body));
}

const rpcError = (message, code = -32000) => ({ jsonrpc: '2.0', error: { code, message }, id: null });

export function checkRemoteAllowed({ host, allowRemote }, pro) {
  if (LOOPBACK.has(host)) return;
  if (!allowRemote) {
    throw new Error('Refusing to bind beyond localhost. Put Commander behind an HTTPS reverse proxy and set IMALI_ALLOW_REMOTE=1 (see deploy/).');
  }
  if (!pro) throw new Error(proMessage('Remote access'));
}

export async function startHttp(settings, { createServer, audit, version, pro = false }) {
  const { host, port, trustProxy, maxSessions } = settings;
  checkRemoteAllowed(settings, pro);

  const authorized = makeAuthorizer(settings);
  const limiter = makeLimiter();
  const sessions = new Map();

  const clientIp = req => {
    if (trustProxy) {
      // Last hop is the one our own proxy appended; earlier ones are client-controlled.
      const hops = String(req.headers['x-forwarded-for'] || '').split(',').map(s => s.trim()).filter(Boolean);
      if (hops.length) return hops[hops.length - 1];
    }
    return req.socket.remoteAddress || 'unknown';
  };

  const httpServer = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');

    if (url.pathname === '/health' && req.method === 'GET') {
      return sendJson(res, 200, { status: 'ok', version, edition: pro ? 'pro' : 'free', sessions: sessions.size, readOnly: settings.readOnly });
    }
    if (url.pathname !== '/mcp') { res.writeHead(404).end(); return; }

    const ip = clientIp(req);
    if (limiter.blocked(ip)) {
      return sendJson(res, 429, rpcError('Too many requests'), { 'Retry-After': String(limiter.retryAfter(ip)) });
    }

    const supplied = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!supplied || !authorized(supplied)) {
      limiter.fail(ip);
      audit({ session: 'http', event: 'auth_failed', ip });
      res.writeHead(401, { 'WWW-Authenticate': 'Bearer' }).end('Unauthorized');
      return;
    }

    try {
      const sessionId = req.headers['mcp-session-id'];
      const body = req.method === 'POST' ? await readJsonBody(req) : undefined;

      if (sessionId) {
        const session = sessions.get(sessionId);
        if (!session) return sendJson(res, 404, rpcError('Unknown or expired session'));
        session.lastSeen = Date.now();
        return await session.transport.handleRequest(req, res, body);
      }

      if (req.method !== 'POST' || !isInitializeRequest(body)) {
        return sendJson(res, 400, rpcError('No session: send an initialize request first'));
      }
      if (sessions.size >= maxSessions) return sendJson(res, 503, rpcError('Too many sessions'));

      let server;
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: randomUUID,
        onsessioninitialized: id => {
          sessions.set(id, { server, transport, lastSeen: Date.now() });
          audit({ session: id, event: 'session_opened', ip, client: body?.params?.clientInfo?.name });
        },
      });
      server = createServer(`http:${ip}`);
      transport.onclose = () => {
        if (transport.sessionId) {
          sessions.delete(transport.sessionId);
          audit({ session: transport.sessionId, event: 'session_closed' });
        }
        server.close().catch(() => {});
      };
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (e) {
      if (!e.status) console.error(e);
      sendJson(res, e.status || 500, rpcError(e.status ? e.message : 'Internal error'));
    }
  });

  // Close sessions idle for 30 minutes so abandoned clients free their slot.
  const sweeper = setInterval(() => {
    const cutoff = Date.now() - 30 * 60 * 1000;
    for (const [id, s] of sessions) if (s.lastSeen < cutoff) s.transport.close().catch(() => {});
  }, 60 * 1000);
  sweeper.unref();

  const shutdown = async () => {
    clearInterval(sweeper);
    httpServer.close();
    await Promise.allSettled([...sessions.values()].map(s => s.transport.close()));
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await new Promise((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(port, host, resolve);
  });
  console.error(`IMALI Commander ${version} listening on http://${host}:${port}/mcp${settings.readOnly ? ' (read-only)' : ''}`);
  return httpServer;
}
