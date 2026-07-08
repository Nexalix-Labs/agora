# Changelog

All notable changes to Nexalix Agora are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
See [CONTRIBUTING.md](CONTRIBUTING.md#versioning) for the release rules.

## [Unreleased]

_Nothing yet._

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
