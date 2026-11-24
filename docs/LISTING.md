# IMALI Commander: listing kit

Copy for MCP directories and marketplaces. Keep claims to what the product does.

## Name
IMALI Commander

## Tagline (under 80 characters)
Safe, scoped file access for AI assistants. One folder, no shell.

## Short description (under 160 characters)
Self-hosted MCP server that gives Claude, ChatGPT and other AI assistants read/write access to one folder, with audit log, read-only mode and remote HTTPS.

## Long description
IMALI Commander lets AI assistants work with your files without handing them your whole computer. You choose one folder; the assistant can list, read, write, search, upload and download files there and check git status, and nothing else. There is no shell and no way out of the folder: `../` paths and symlink tricks are blocked.

Every action is written to an audit log (never file contents), read-only mode lets an assistant look without touching, and access tokens are stored only as hashes with brute-force lockout. Run it locally for Claude Desktop in one command, or as a background service.

**Pro** ($9/month or $79/year) adds remote HTTPS access, so ChatGPT and web-based assistants can reach it through a one-command Docker + Caddy setup with automatic certificates, plus multiple workspaces.

## Key features
- One approved folder per workspace; `../` and symlink escapes blocked
- 10 tools: list, read, write, upload, download, create folder, file info, search, workspace info, safe git/ls commands
- No shell or arbitrary programs
- Read-only mode
- Audit log of tool calls, sessions and failed logins
- Hashed access tokens, constant-time checks, lockout after repeated failures
- stdio for desktop clients; authenticated Streamable HTTP
- Background service for macOS (launchd) and Linux (systemd)
- Pro: remote HTTPS (Docker + Caddy), multiple workspaces

## Categories / tags
File system, Developer tools, Security, Productivity, Self-hosted

Keywords: mcp, mcp-server, filesystem, file access, claude desktop, chatgpt connector, self-hosted, secure, audit log, read-only

## Install snippet
```bash
npm install -g imali-commander
imali-commander init --workspace ~/ai-workspace
```

```json
{ "mcpServers": { "imali-commander": { "command": "npx", "args": ["-y", "imali-commander", "start"] } } }
```

## How it compares (positioning, for your own use)
- **vs. general "desktop commander" style servers:** those usually expose a shell and the whole disk; Commander deliberately doesn't. Pitch: "for when you want the assistant in one folder, not your whole machine."
- **vs. the reference filesystem server:** Commander adds audit logging, read-only mode, hashed-token HTTP with lockout, a service installer and a remote HTTPS deploy.

## Where to list it (after `npm publish`)
1. **Official MCP Registry**: `mcp-publisher login github`, then `mcp-publisher publish` from this folder (uses `server.json`). Many directories pull from it.
2. **Smithery, mcp.so, Glama, PulseMCP**: submit the GitHub repo URL through each site's add-server form.
3. **awesome-mcp-servers on GitHub**: open a pull request adding one line under File Systems.
4. **Your own channels**: a short demo video (Claude editing files in one folder, then the audit log), posted where you already post for Sports Jedi and IMALI.

## Screenshots to make
1. Terminal: `imali-commander init` output (blur the token).
2. Claude Desktop using Commander to edit a file in the workspace.
3. `imali-commander status` and an audit log excerpt.
4. Read-only mode refusing a write.
