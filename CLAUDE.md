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

## Skills — use by priority

Load/run these as part of normal work on this repo, in this order of
importance. Higher tiers are not optional.

1. **Always, on every change:**
   - `rust-clean-code` — before writing/reviewing any `src-tauri/` Rust.
   - `karpathy-guidelines` — surgical, minimal edits; don't "improve"
     neighbouring code.
   - `verify` (or `/run`) — drive the feature in the real app before
     claiming done. Pure logic (e.g. `units.ts`) gets a runtime check,
     not just `tsc`.
2. **Before calling a batch done (definition of done):**
   - `/code-review` on the diff — **mandatory when the change touches
     `unsafe`/Win32 in `lib.rs`** (clipboard, monitor, shell FFI).
   - `Workflow` (dynamic workflows) for any multi-step or adversarial
     review — fan-out + verify, not manual parallel agents. Used for the
     converter review; use again for unsafe-code audits.
   - `/simplify` or `/grill` — quality pass / adversarial self-review on
     tricky logic before commit.
3. **Situational, by area:**
   - `security-and-hardening` (or gstack `/cso`) — anything touching
     clipboard privacy, the updater/signing, or `unsafe` memory.
   - `frontend-ui-engineering` / `design-taste-frontend` — launcher or
     settings UI polish.
   - `git-workflow-and-versioning` — mirrors the versioning rules above.
   - `browser-testing-with-devtools` — real-browser frontend checks.
   - `debugging-and-error-recovery` — systematic root-cause over guessing.

Global workflow commands already installed: `/go` (verify→simplify→PR),
`/grill`, `/techdebt`, `/commit-push-pr`.

## Layout

- `src/main.ts` — launcher (search, providers: calc/convert/crypto/
  weather/web/clipboard, actions, query history). `src/settings.ts` +
  `settings.html` — settings window.
- `src/units.ts` — pure offline unit/temperature/number-base conversion
  (no I/O, no DOM). `src/engines.ts` — web/AI search engines.
  `src/i18n.ts` — 17 languages (EN source, rest fall back to EN).
- `src-tauri/src/lib.rs` — Win32 shell (app enum, icons, actions),
  hotkeys, settings persistence, tray, updater, clipboard-history watcher.
- Signing key: `~/.tauri/agora.key` (not in repo). Prod deploy of the site
  is via rsync of the built `dist` to the `workspace` server.
