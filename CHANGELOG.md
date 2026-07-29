# Changelog

All notable changes to Nexalix Agora are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
See [CONTRIBUTING.md](CONTRIBUTING.md#versioning) for the release rules.

## [Unreleased]

## [0.8.0] — 2026-07-29

### Added
- Converters plugin: type a conversion straight into the bar.
  - Units — length, mass, volume, area, speed, duration, digital storage
    and angle. `10 km in mi`, `72f to c`, `5 kg to lb`, `2 gb to mb`.
    Digital storage uses binary units (1 KB = 1024 B), matching Explorer.
  - Currency — live rates for 50 codes via exchangerate-api (no key),
    cached one hour. `100 usd to eur`, `1500 rub to usd`.
  - Number bases — `255 to hex`, `0b1010 to dec`; a bare literal like
    `0xFF` shows its decimal, octal and binary forms at once.
  - Timestamps — `unix now` for the current epoch, `1700000000 as date`
    to read an epoch back as local + UTC time.
- Query history: press ↑ on an empty bar to recall recent queries, ↓ to
  step back toward what you were typing. Last 50, stored locally.
- Clipboard History plugin: everything you copy is kept (last 50, in
  memory only — never written to disk). Type `clip` (or `буфер`) to
  browse, add words to filter, Enter to put an entry back on the
  clipboard. Respects apps that opt out of clipboard history (password
  managers), and skips non-text and empty copies. Disabling the plugin
  stops collection and clears what was already captured.
- Kill Process plugin: type `kill` for a live list of running processes
  (biggest by memory first), add a name to filter (`kill chrome`), and
  press Enter to end the selected one — the list refreshes so you can
  end more. Shows PID and memory to tell duplicates apart. Critical
  system processes are hidden and refused (checked with `IsProcessCritical`)
  so you can't blue-screen the machine even when running elevated; Agora's
  own processes are excluded too.
- PC mode actions: type `game` (or `игра`) to switch the machine into a
  gaming profile — Windows Game Mode on and notifications silenced (a
  Do-Not-Disturb equivalent). Type `work` (or `работа`) to switch back —
  Game Mode off, notifications restored. All toggles are reversible and
  need no admin rights (`powercfg` plus `HKCU`).
  Power plans are picked by name: your own schemes named `GAME` / `WORK`
  win, falling back to Windows' High Performance / Balanced. Machines
  where the stock schemes were removed keep working, and a custom plan
  stays in charge of what each mode actually does.
  The active mode is marked right in the results (`PC mode · on`), read
  from the live power scheme, and updates the moment you switch.

- SSH plugin: type `ssh` for the hosts in your `~/.ssh/config`, each with a
  live reachability check. The indicator is a TCP connect to that host's real
  SSH port, so it answers the question that matters — can I connect right
  now — and it reads the SSH banner before closing, which keeps `sshd` from
  logging a failed connection for every check. Add a name to filter
  (`ssh prod`); Enter opens a Windows Terminal tab already connected, titled
  with the alias. Hosts with `LocalForward` are marked as carrying tunnels.
  Probes only ever touch the hosts currently on screen, on demand.
  New hosts can be added from Settings → SSH: Agora appends a marked block to
  the end of your config and never rewrites what is already there, so hosts
  work in every other ssh client too. Only blocks Agora added itself can be
  removed from the UI; hand-written ones are shown read-only.
  Sessions open in whatever you actually use: Settings → SSH lets you pick
  between running `ssh` directly (the tab closes when you disconnect) or
  inside PowerShell, PowerShell 7 or cmd (the shell stays open afterwards),
  and which Windows Terminal profile the tab uses — the list is read from
  Terminal's own settings, so the session gets your usual colours, font and
  background instead of the default profile.
  Authentication is keys and `ssh-agent` only — stock Windows OpenSSH cannot
  accept a password non-interactively, so password hosts simply prompt in the
  terminal that opens, as usual.
- Power plans in the launcher: every scheme from `powercfg.cpl` — the
  Windows ones and your own — is now a result. Type a plan name (or
  `power`, `схема`, `питание`) and press Enter to make it active; the
  current one is marked. Unlike the PC mode actions, picking a plan only
  switches power — Game Mode and notifications stay as they are. The PC
  mode actions themselves got their own switch in Settings → Plugins, so
  you can keep the bare Windows plans and nothing else.

### Changed
- Updates now ask first, like a messenger: Agora checks in the
  background (on start and every 6 h) and, when a version is out, offers
  a single row in the launcher. Enter downloads it with a percentage in
  the row, then the app closes, installs silently and comes back on the
  new version — no installer wizard, nothing to click. Previously the
  update was downloaded and installed unannounced at startup.
- Power schemes are read through the `powrprof` API instead of parsing
  `powercfg /list`: scheme names come back correct in any Windows
  locale (console output is OEM-encoded and unreadable), and switching
  no longer spawns a console process.

### Fixed
- Launcher now opens on the monitor under the mouse cursor, not always the
  primary one. It previously read `current_monitor()` of the still-hidden
  window, which resolves to the default monitor regardless of where you
  are. Now the target monitor is picked from the live cursor position
  (`GetCursorPos` → `MonitorFromPoint`), with a `current_monitor`/`center`
  fallback.

## [0.7.0] — 2026-07-08

### Added
- Smart calculator: implicit multiplication (`1+2(50*1)`), functions
  (`sqrt`, `sin`, `cos`, `log`, `ln`, …), constants (`pi`, `e`, `tau`),
  and smart percentages (`200+15%` → 230). Expressions are validated
  before evaluation.
- Web search engine picker: Google, DuckDuckGo, Bing, Yandex — or ask an
  AI (Claude, ChatGPT, Perplexity) that opens a chat with your query.
  Prefixes work anywhere: `g:`, `c:`, `gpt:`, `p:`.

### Changed
- System actions are localized and now found by keyword in any interface
  language, plus latin aliases.
- Plugins pane cleaned up: **Recent Files** is a plain toggle, not a
  plugin; **Web Search** became **Web & AI search**.

### Fixed
- System commands (lock, sleep, dark mode, empty trash) were unfindable
  when searching in a non-English language — they now resolve
  (`блокировка` → Lock Screen, etc.).

## [0.6.0] — 2026-07-08

### Added
- Weather: type `weather` (in any of the 17 languages) for today's
  forecast — conditions, high/low, wind, morning-to-evening — for a
  configured city.
- Custom global hotkeys: bind a key combo to launch an app or run a
  command.
- Crypto rates now resolve any ticker dynamically (new and renamed coins
  included), no hardcoded list.

### Changed
- Hover-to-focus launcher; layout-independent hotkey capture.
- Branded installer art, sharper on HiDPI.
- Direct-download link (`releases/latest/download/nexalix-agora-setup.exe`)
  always fetches the current build.

## [0.5.1] — 2026-07-08

### Added
- Branded NSIS installer with a license page.

## [0.5.0] — 2026-07-08

### Added
- Crypto rates in the search bar via CoinGecko.

## [0.4.0] — 2026-07-07

### Added
- First public release: Spotlight-style launcher (apps, recent files,
  system actions, calculator, web fallback), settings window, 17
  interface languages, tray, autostart, signed auto-updates.

[Unreleased]: https://github.com/Nexalix-Labs/agora/compare/v0.8.0...HEAD
[0.8.0]: https://github.com/Nexalix-Labs/agora/releases/tag/v0.8.0
[0.7.0]: https://github.com/Nexalix-Labs/agora/releases/tag/v0.7.0
[0.6.0]: https://github.com/Nexalix-Labs/agora/releases/tag/v0.6.0
[0.5.1]: https://github.com/Nexalix-Labs/agora/releases/tag/v0.5.1
[0.5.0]: https://github.com/Nexalix-Labs/agora/releases/tag/v0.5.0
[0.4.0]: https://github.com/Nexalix-Labs/agora/releases/tag/v0.4.0
