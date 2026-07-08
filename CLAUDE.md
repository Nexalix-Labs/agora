# Nexalix Agora — agent & contributor rules

Spotlight-style launcher for Windows (Tauri 2 · Rust backend · vanilla TS
frontend). Repo: `github.com/Nexalix-Labs/agora`. Site: `agora.nexalix.io`
(lives in the `nexalix-labs` monorepo, page `src/pages/agora.astro`).

**Read [CONTRIBUTING.md](CONTRIBUTING.md) before changing anything.** The
rules below are load-bearing; follow them exactly.

## Versioning — do not churn

- [SemVer](CONTRIBUTING.md#versioning): PATCH = fixes, MINOR = features,
  MAJOR = 1.0/breaking. Pre-1.0 today.
- **One version = one coherent shippable batch.** Do NOT cut a release per
  commit or bump three times in a session. Accumulate under
  `## [Unreleased]` in [CHANGELOG.md](CHANGELOG.md) and release in a
  meaningful group.
- Version lives in **three files, always identical**: `package.json`,
  `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`.
- Release = update CHANGELOG (Unreleased → `[X.Y.Z] — date`) → bump three
  files → annotated tag `vX.Y.Z` with the changelog entry as message →
  push tag. CI builds/signs/publishes. Never hand-publish; never bump
  without a CHANGELOG entry. Full steps in CONTRIBUTING.

## Code gates (definition of done)

- Rust (`src-tauri/`): run the `rust-clean-code` skill; `cargo fmt --check`
  and `cargo clippy --all-targets --all-features -- -D warnings` must be
  clean. No `unwrap`/`expect`/`panic!` on runtime paths (`[lints]` enforces).
- Frontend (`src/`): `pnpm build` (runs `tsc`) clean. Vanilla TS, no
  framework. User strings via `src/i18n.ts` (EN = source of truth).
- Verify features in the real app before claiming done.

## Layout

- `src/main.ts` — launcher (search, providers: calc/crypto/weather/web,
  actions). `src/settings.ts` + `settings.html` — settings window.
- `src/engines.ts` — web/AI search engines. `src/i18n.ts` — 17 languages.
- `src-tauri/src/lib.rs` — Win32 shell (app enum, icons, actions),
  hotkeys, settings persistence, tray, updater.
- Signing key: `~/.tauri/agora.key` (not in repo). Prod deploy of the site
  is via rsync of the built `dist` to the `workspace` server.
