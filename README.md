# IMALI Commander

Give AI assistants (Claude Desktop, ChatGPT and any MCP client) safe access to
**one folder** on your computer or server: read, write, upload, download,
search, and check git status. Nothing outside that folder, no shell.

- Scoped to a single workspace folder; symlink and `../` escapes are blocked
- Works locally over stdio, or remotely over authenticated HTTPS
- Read-only mode for "look but don't touch"
- Audit log of every action (never file contents or tokens)
- Token stored only as a hash; brute-force lockout
- One command to run as a background service on macOS or Linux

## Free and Pro

| | Free | Pro |
|---|---|---|
| All 10 tools, read-only mode, audit log | ✔ | ✔ |
| Claude Desktop and other local clients (stdio) | ✔ | ✔ |
| Local HTTP (`127.0.0.1`) | ✔ | ✔ |
| **Remote HTTPS access** (ChatGPT, web assistants, other machines) | | ✔ |
| **Multiple workspaces** (`imali-commander workspace add`) | | ✔ |
| Priority email support | | ✔ |
| Price | $0 | $9/month or $79/year |

Activate Pro with `imali-commander activate <license-key>`, then restart.
The license is checked at most once a day; if you're offline, Pro keeps
working for 7 days from the last successful check. Free never contacts the
internet.

## Install

Requires Node.js 20+.

```bash
npm install -g imali-commander
imali-commander init --workspace ~/imali-workspace
```

`init` prints your access token **once** plus a ready-to-paste client config.

## Connect a desktop client (stdio)

Paste the JSON that `init` printed into your client's MCP config, e.g. Claude
Desktop → Settings → Developer → Edit Config, then restart the client. Without a
global install you can also run it through npx:

```json
{
  "mcpServers": {
    "imali-commander": { "command": "npx", "args": ["-y", "imali-commander", "start"] }
  }
}
```

The config `init` prints looks like:

```json
{
  "mcpServers": {
    "imali-commander": { "command": "/usr/local/bin/node", "args": ["/…/imali-commander/src/server.js"] }
  }
}
```

## Run over HTTP

```bash
imali-commander start --http                 # foreground, http://127.0.0.1:8787/mcp
imali-commander service install --load       # background service that starts at login
```

Clients send `Authorization: Bearer <token>`. Commander only listens on
localhost; for access from other machines put it behind HTTPS (next section).

## Remote access over HTTPS

Remote access is a Pro feature.

**Docker (recommended):** Commander plus Caddy with automatic Let's Encrypt certificates.

```bash
cp deploy/.env.example deploy/.env     # set DOMAIN, IMALI_MCP_TOKEN_SHA256 and IMALI_LICENSE_KEY
docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d
```

Endpoint: `https://<DOMAIN>/mcp`. Only `/mcp` and `/health` are exposed.

**Without Docker:** run Commander as a service, set `"trustProxy": true` in the
config, and use `deploy/Caddyfile.host` with Caddy on the same machine.

## Commands

| Command | What it does |
|---|---|
| `init [--workspace <dir>] [--port <n>] [--read-only] [--force]` | Set up, print token and client config |
| `start [--http] [--workspace <dir>] [--port <n>] [--read-only]` | Run the server (stdio by default) |
| `status` | Show settings and whether it's running |
| `doctor` | Check Node, permissions, workspace, port, token |
| `rotate-token` | New token (restart to apply) |
| `activate <key>` / `deactivate` | Turn Pro on, or free this machine's seat |
| `license [--check]` | Show edition; `--check` re-validates now |
| `workspace list \| add <name> <dir> \| remove <name>` | Extra workspaces (Pro); tools then take an optional `workspace` argument |
| `service install [--load] \| restart \| uninstall` | Background service (launchd / systemd) |

## Tools

`device_info`, `list_files`, `read_file`, `write_file`, `download_file`,
`upload_file`, `create_directory`, `file_info`, `search_files`,
`run_workspace_command` (`pwd`, `ls`, `git-status`, `git-diff`, `git-log` only).
Read-only mode removes `write_file`, `upload_file` and `create_directory`.

Limits: text files 1 MB, transfers 5 MB, HTTP body 8 MB, commands 5 s / 32 KB output.

## Configuration

`~/.imali-commander/config.json` (created by `init`, mode 600). Environment
variables override it; change the config folder with `IMALI_HOME`.

| Env var | Config key | Default |
|---|---|---|
| `IMALI_WORKSPACE` | `workspace` | `~/imali-workspace` |
| `IMALI_TRANSPORT` | — | `stdio` (`http` for HTTP) |
| `IMALI_HOST` / `IMALI_PORT` | `host` / `port` | `127.0.0.1` / `8787` |
| `IMALI_MCP_TOKEN` | — | plaintext token (32+ chars), overrides the hash |
| `IMALI_MCP_TOKEN_SHA256` | `tokenSha256` | set by `init` |
| `IMALI_READ_ONLY` | `readOnly` | `false` |
| `IMALI_ALLOW_REMOTE` | `allowRemote` | `false`; only behind an HTTPS proxy |
| `IMALI_TRUST_PROXY` | `trustProxy` | `false`; `true` behind a reverse proxy |
| `IMALI_MAX_SESSIONS` | `maxSessions` | `16` |
| `IMALI_AUDIT_LOG` | `auditLog` | `~/.imali-commander/logs/audit.log` (`off` disables) |
| `IMALI_LICENSE_KEY` | `license` | Pro key; activates on first start (for containers) |
| — | `workspaces` | extra workspaces, set with `imali-commander workspace add` |

## Troubleshooting

- **Client shows no tools:** run `imali-commander doctor`, then restart the client.
- **401 Unauthorized:** wrong token. Run `imali-commander rotate-token`, then `service restart`.
- **429 Too many requests:** 10 bad tokens within a minute locks that address out for the rest of the minute.
- **Service logs:** `~/.imali-commander/logs/service.log`.

See [SECURITY.md](SECURITY.md) for the security model and [CHANGELOG.md](CHANGELOG.md) for releases.
