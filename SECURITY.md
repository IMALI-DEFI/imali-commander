# Security model

## What Commander protects

- **One folder only.** Every path is resolved and checked against the real
  path of the workspace, including each parent directory, so `../` and
  symlinks pointing outside are refused.
- **No shell.** The only commands are a fixed list (`pwd`, `ls -la`,
  `git status/diff/log`) run without a shell, with a minimal environment,
  a 5-second timeout and 32 KB output cap.
- **Authenticated HTTP.** Bearer token, compared in constant time. `init`
  stores only its SHA-256; the plaintext is shown once.
- **Brute-force lockout.** 10 failed tokens per client per minute locks that
  client out for the rest of the minute; 600 requests/minute cap per client.
- **Localhost by default.** HTTP refuses to bind to a public address unless
  `IMALI_ALLOW_REMOTE=1` is set, which is meant only behind an HTTPS proxy.
- **Bounded input.** 1 MB text, 5 MB transfers, 8 MB request bodies,
  16 concurrent sessions; idle sessions close after 30 minutes.
- **Audit log.** Every tool call, session open/close and failed login is
  logged with time, tool, path, size and result. Contents and tokens are never logged.

## What it does not protect against

- **Anything the assistant can do with files you put in the workspace.** Use
  read-only mode when it only needs to look.
- **A compromised machine or user account.** Run Commander as a normal,
  unprivileged user; the Docker image runs as a non-root user with a
  read-only root filesystem.
- **Plain HTTP over a network.** Only use HTTP on localhost; use the
  `deploy/` HTTPS setup for anything remote.
- **Race conditions from other programs** changing symlinks inside the
  workspace while a request is running. Don't share the workspace with
  untrusted local users.

## Operational advice

- Give each person or device its own install and token; rotate with
  `imali-commander rotate-token`.
- Keep the workspace a dedicated folder, never your home folder or `/`
  (`imali-commander doctor` warns about this).
- Review `~/.imali-commander/logs/audit.log` for unexpected activity.

## Reporting a vulnerability

Report it privately through GitHub: open the **Security** tab of this repository
and choose **Report a vulnerability**. Please include steps to reproduce, and
don't open a public issue.
