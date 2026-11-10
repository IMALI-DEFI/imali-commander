# IMALI Commander tool reference

All paths are relative to the workspace. With more than one workspace (Pro),
every tool also accepts an optional `workspace` name.

| Tool | Arguments | Returns | Limits |
|---|---|---|---|
| `device_info` | none | platform, hostname, workspace path, version, readOnly, workspace names | |
| `list_files` | `directory` (default `.`) | name and type (file, directory, symlink) per entry | |
| `read_file` | `file` | UTF-8 text | 1 MB |
| `write_file` | `file`, `content` | confirmation; creates parent folders; replaces the file | 1 MB |
| `download_file` | `file` | name, size, base64 data | 5 MB |
| `upload_file` | `file`, `data` (base64) | path written and byte count | 5 MB |
| `create_directory` | `directory` | confirmation | |
| `file_info` | `file` | size, directory/symlink flags, modified time | |
| `search_files` | `query`, `directory` (default `.`) | up to 100 matching paths; `limited: true` if cut short | name match only; skips `node_modules` and `.git` |
| `run_workspace_command` | `command`: `pwd`, `ls`, `git-status`, `git-diff`, `git-log`; `directory` | exit code and output | 5 s, 32 KB |

Read-only mode removes `write_file`, `upload_file` and `create_directory`.

Failed calls return `isError: true` with a message starting `Error:`.

## CLI the user can run

| Command | Purpose |
|---|---|
| `imali-commander init [--workspace <dir>] [--read-only] [--force]` | Set up; prints client config and token once |
| `imali-commander start [--http]` | Run the server (stdio by default) |
| `imali-commander status` / `doctor` | Show settings / check the install |
| `imali-commander rotate-token` | Issue a new access token |
| `imali-commander service install --load` | Run in the background (macOS, Linux) |
| `imali-commander workspace list \| add <name> <dir> \| remove <name>` | Extra workspaces (Pro) |
