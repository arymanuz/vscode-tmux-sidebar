# Changelog

All notable changes to this extension are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-07-20

First release under the name **Tmux Sidebar**. This is a fork of
[ZeroRegister/vscode-tmux-manager](https://github.com/ZeroRegister/vscode-tmux-manager)
at version 0.2.0; everything below is relative to that.

### Added

- **Windows support.** On Windows the extension drives
  [psmux](https://github.com/psmux/psmux), a native tmux-compatible multiplexer.
  The choice follows the platform the extension host runs on, so a WSL, SSH or
  container remote still uses `tmux` on that machine.
- Two separate **Split Right** and **Split Down** buttons on panes, replacing the
  single button that opened a direction picker.
- A hint shown in the empty view when no sessions exist, with a button to create
  the first one.
- A marketplace gallery icon.

### Changed

- Renamed the extension to **Tmux Sidebar**, with a tmux-style icon of a tiled
  window in place of the generic terminal glyph.
- Attach terminals are named `tmux - <session>` and carry the extension icon
  instead of the shell's.
- The multiplexer is now the terminal's main process, so leaving it closes the
  tab instead of dropping back into a shell. The command is passed as shell
  arguments, so relaunching a terminal or restoring a session reattaches rather
  than leaving a bare shell.
- A missing `tmux`/`psmux` is reported with a single install command detected
  from the system's own package manager.
- The published package no longer ships TypeScript sources, source maps or build
  config, which took it from 324 KB to 17 KB.

### Fixed

- No error when there are no tmux sessions. All "no server running" phrasings are
  recognised — tmux 3.6 reports `error connecting to ...` — and sessions are
  queried first, so `list-windows` and `list-panes` are never called without a
  running server.
- Attaching twice to the same session no longer opens a duplicate terminal when
  tmux has rewritten the tab title through escape sequences.

### Removed

- Chinese documentation (`README_zh.md`).
- Unused icon assets, replaced by VS Code's built-in codicons.
