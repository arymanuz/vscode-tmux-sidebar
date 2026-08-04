# Changelog

All notable changes to this extension are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.1] - unreleased

### Added

- Kimi Code (`kimi`) and OpenClaw (`openclaw chat` / `openclaw tui`) in the
  default program list.
- Richer default menus for the AI tools, with flags verified against each
  tool's current documentation: codex gains resume and fork (both open the
  tool's own session picker), kimi gains its session picker, plan mode and
  the stable kimi-for-coding alias, aider gains architect and watch-files
  modes, and codex and opencode gain free model fields (joining claude,
  gemini, agy, kimi and aider). Presets that would silently resume "the
  most recent" session are deliberately absent — with several tmux panes
  which session is most recent is anyone's guess — as are pinned model
  versions, which age faster than the extension updates.

### Changed

- The settings page opens on the This workspace tab when the workspace has
  its own overrides, since that is what governs the current window; on the
  Global tab otherwise.

### Fixed

- The suggested session name stays fully selected when the form opens, so
  typing replaces it. The async arrival of the program list was collapsing
  the selection a moment after opening.

## [1.0.0] - 2026-07-26

First release under the name **Tmux Sidebar**. This is a fork of
[ZeroRegister/vscode-tmux-manager](https://github.com/ZeroRegister/vscode-tmux-manager)
at version 0.2.0; everything below is relative to that.

### Added

- **Windows support.** On Windows the extension drives
  [psmux](https://github.com/psmux/psmux), a native tmux-compatible multiplexer.
  The choice follows the platform the extension host runs on, so a WSL, SSH or
  container remote still uses `tmux` on that machine.
- **A create form** for sessions, windows and splits: name, working directory
  (project folders one click away, plus native browse), what to run, and create
  buttons for both terminal locations. Panes split in all four directions.
- **A program launcher** inside that form: shells, REPLs, AI tools (claude,
  codex, gemini, aider — each with resume and model variants and a free model
  field), git TUIs, or any command typed by hand. Only installed programs are
  offered; duplicates are collapsed by the binary's canonical path, so python
  and python3 pointing at one interpreter show once; `{default-shell}` resolves
  to the shell tmux itself would start.
- **A settings page** behind a gear on the view title: auto-refresh and its
  interval, where new terminals open (VS Code default, editor area, or panel),
  and the full program list — editable, reorderable, with installed-state dots
  and a re-check button that picks up newly installed tools without reloading
  VS Code. Tabs switch between editing the global settings and this
  workspace's own; saving globally clears the workspace overrides so the saved
  values apply everywhere. Everything lives in the `tmuxSidebar.*`
  configuration, so settings.json editing works too.
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
- Routine successes (created, killed, switched, attached) show briefly in the
  status bar instead of stacking notification popups; failures stay loud.
- The single Toggle Auto Refresh menu entry, which didn't show the current
  state, is replaced by the settings page.
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
