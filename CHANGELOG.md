# Changelog

## 1.2.0 - 2026-11-03

- Pro licensing moves to Stripe: buy at https://api.imali-defi.com/commander/buy,
  keys issued instantly after checkout, up to 3 machines per license, billing
  portal for card changes and cancellation
- `license-server/`: the self-hosted license service (Stripe Checkout, webhooks,
  activations, SQLite); not part of the npm package

## 1.1.0 - 2026-11-03

- IMALI Commander Pro: `activate`, `deactivate`, `license [--check]` (license keys,
  daily re-check, 7-day offline grace; Free never contacts the internet)
- Pro: remote HTTPS access (binding beyond localhost) and multiple workspaces
  (`workspace add|list|remove`); tools gain an optional `workspace` argument only
  when more than one workspace is configured, so Free tool schemas are unchanged
- Docker: `IMALI_LICENSE_KEY` activates once and is kept in the data volume
- `/health` reports the edition; `status` shows Free or Pro

## 1.0.0 - 2026-11-03

First self-install release.

- `imali-commander` CLI: `init`, `start`, `status`, `doctor`, `rotate-token`, `service install|restart|uninstall`
- Config file at `~/.imali-commander/config.json` (mode 600); env vars still override
- Access token stored only as a SHA-256 hash; shown once at `init`/`rotate-token`
- Read-only mode (`--read-only` / `IMALI_READ_ONLY`)
- Audit log of tool calls, sessions and failed logins (no contents or tokens), rotates at 10 MB
- Brute-force lockout and per-client request cap on HTTP
- Remote binding only with `IMALI_ALLOW_REMOTE=1`; `IMALI_TRUST_PROXY` for reverse proxies
- Idle HTTP sessions close after 30 minutes
- Docker image and `deploy/` setup with Caddy for automatic HTTPS
- launchd (macOS) and systemd (Linux) background service
- Unchanged: the 10 tools, their inputs and output text, `node src/server.js`

## 0.4.0 - 2026-11-02

- One MCP session per HTTP client (several clients and reconnects at once)
- `GET /health`, tool errors flagged with `isError`, 8 MB body cap

## 0.3.0

- Local authenticated Streamable HTTP transport

## 0.2.0

- Ten local MCP tools including bounded base64 upload/download
