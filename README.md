<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="src/assets/logo.svg" />
  <source media="(prefers-color-scheme: light)" srcset="src/assets/logo-light.svg" />
  <img src="src/assets/logo.svg" alt="Verne" width="200" />
</picture>


### The IDE for your CLI agents

<br />

Wrap Claude Code, Codex, or any CLI agent in a real workspace; files, editor, browser, and git, all agent-aware. Multiple projects, optional worktrees, zero forced workflow.

<br />

[![License: GPLv3](https://img.shields.io/badge/License-GPLv3-informational.svg)](./LICENSE.txt)

<br />

[**Download (macOS)**](https://github.com/verne-build/verne/releases/latest) &nbsp;&bull;&nbsp; [**Changelog**](https://github.com/verne-build-verne/releases)

</div>

## Features

| Feature | Description |
| --- | --- |
| Multi-repo workspace | Track multiple local repos as working directories |
| Terminals | Open terminal tabs per directory; launch Claude Code / Codex / OpenCode and more |
| Persistent sessions | Sessions survive app restart — a persistent daemon owns the PTYs |
| Agent detection | Auto-detect which agent is running in a tab and its state (working / blocked / idle) |
| Code editor | Browse files, open tabs, edit in-app with Monaco + LSP |
| Browser | Embedded browser tabs with CDP automation exposed to agents via MCP |
| Notes | Notes per workspace, readable by agents over MCP |
| Voice | On-device speech-to-text via sherpa-onnx, with developer-term and number post-processing |

## Licence

Distributed under the GNU General Public Licence 3.0. See [LICENCE.txt](LICENCE.txt) for more information