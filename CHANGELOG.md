# Changelog

All notable changes to Nexalix Agora are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
See [CONTRIBUTING.md](CONTRIBUTING.md#versioning) for the release rules.

## [Unreleased]

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

[Unreleased]: https://github.com/Nexalix-Labs/agora/compare/v0.7.0...HEAD
[0.7.0]: https://github.com/Nexalix-Labs/agora/releases/tag/v0.7.0
[0.6.0]: https://github.com/Nexalix-Labs/agora/releases/tag/v0.6.0
[0.5.1]: https://github.com/Nexalix-Labs/agora/releases/tag/v0.5.1
[0.5.0]: https://github.com/Nexalix-Labs/agora/releases/tag/v0.5.0
[0.4.0]: https://github.com/Nexalix-Labs/agora/releases/tag/v0.4.0
