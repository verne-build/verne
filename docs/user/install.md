# Install Verne

Verne is a web and desktop GUI for running coding agents on your machine.

## Requirements

Node.js `^22.16 || ^23.11 || >=24.10` on the machine that runs the Verne server.

At least one provider CLI, installed and authenticated. See [Providers](#providers) below.

## Run Without Installing

```bash
npx @verne-build/cli@latest
```

This starts the Verne server on your machine and opens the local web app. Use
`npx @verne-build/cli@latest --help` for the full CLI reference.

## Desktop App

Download desktop builds from
[Verne GitHub Releases](https://github.com/verne-build/verne/releases). Package-manager listings
will be added after the first public release.

## Importing an Existing T3 Code Installation

On first launch, Verne checks its own state under `~/.verne`. If that state is empty and an existing
T3 Code installation is available under `~/.t3`, Verne copies compatible settings, projects,
threads, attachments, secrets, and connection records into its own state. The T3 Code source is
left untouched, and the import does not run after Verne has created state of its own.

The desktop app performs the same empty-state import for compatible Electron preferences. Mobile
apps use separate OS sandboxes because their bundle IDs are different, so installed T3 Code mobile
state cannot be read automatically; server-side projects and threads remain available after the
server import.

### Windows Subsystem for Linux

When the desktop app runs a WSL backend, it installs the matching server runtime into
`~/.verne/wsl-runtime` inside the selected distro. The first launch after installing or updating T3
Code may take a little longer while that release's runtime is extracted. Later launches reuse the
Linux-local copy so startup does not depend on reading application files through `/mnt/c`. After a
successful launch, Verne keeps the current runtime and one previous runtime for rollback and
removes older caches automatically. If a cached runtime stops working, Verne launches from the
application files under `/mnt/c` instead and reinstalls the runtime on the next launch.

## Providers

Verne drives provider CLIs; it does not ship them. Install the CLI for each provider you want
to use, then authenticate it.

| Provider   | CLI                                                   | Default binary | Log in with           |
| ---------- | ----------------------------------------------------- | -------------- | --------------------- |
| Codex      | [Codex CLI](https://developers.openai.com/codex/cli)  | `codex`        | `codex login`         |
| Claude     | [Claude Code](https://claude.com/product/claude-code) | `claude`       | `claude auth login`   |
| Cursor     | [Cursor CLI](https://cursor.com/cli)                  | `cursor-agent` | `agent login`         |
| Grok Build | [Grok Build CLI](https://x.ai/cli)                    | `grok`         | `grok login`          |
| OpenCode   | [OpenCode](https://opencode.ai)                       | `opencode`     | `opencode auth login` |

Codex and Claude are on by default. Cursor, Grok Build, and OpenCode are off by default; turn
them on in **Settings** → the provider's card when you want to use them.

Cursor is the one to watch: install Cursor CLI, which provides the `cursor-agent` binary that
Verne looks for, but authenticate with `agent login`, not `cursor-agent login`.

Grok models that support adjustable reasoning show a **Reasoning** control beside the model picker.
The available levels and default come from the installed Grok Build CLI, so they can vary by model
and CLI version.

Run the login command on the machine running the Verne server, not on the device you browse
from.

### Binary Discovery

Each provider CLI must be on the server's `PATH`, or have an explicit binary path set in
**Settings** → the provider instance → **Binary path**. Use the explicit path when a version
manager or a non-standard install location keeps the CLI off the `PATH` of the shell that
started Verne.

### When Auth Is Needed

Provider auth is required before you start a session with that provider, not before you start
Verne. You can install Verne, open it, and add providers afterwards. A provider that is not
authenticated shows its status in **Settings** and fails at session start with the login command
to run.

For multi-account setups, see [Codex](./providers-codex.md) and [Claude](./providers-claude.md).

## Next Steps

- [Permission modes](./permission-modes.md): how much Verne asks before acting
- [Remote access](./remote-access.md): connect from a phone, tablet, or another desktop
- [Keeping Verne in sync](./updating.md): client and server version skew
- [Running in the background](./background-service.md): Linux background service
