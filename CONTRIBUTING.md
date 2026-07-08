# Contributing to Nexalix Agora

Thanks for helping build Agora. This file is the contract every contributor
— human or agent — is expected to follow. It is intentionally short.

## Versioning

Agora uses [Semantic Versioning](https://semver.org): `MAJOR.MINOR.PATCH`.
While pre-1.0:

| Bump | When | Example |
|------|------|---------|
| **PATCH** (`0.7.0 → 0.7.1`) | Bug fixes, copy tweaks, screenshot/site refreshes — no new user-facing feature | Fix a crash, correct a translation |
| **MINOR** (`0.7.0 → 0.8.0`) | New user-facing feature or capability | Add a plugin, a settings section, a search provider |
| **MAJOR** (`0.x → 1.0.0`) | The product is declared stable, or a breaking change to settings/updater format | First stable release |

**One version = one meaningful, shippable batch.** Do not cut a release per
commit. Accumulate related work on `main` under `## [Unreleased]` in the
[CHANGELOG](CHANGELOG.md), then release when the batch tells a coherent story.
Releasing three versions in an hour is a smell — group the work instead.

The version lives in **three files** and must always match:
`package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`.

## Release process

1. Move everything under `## [Unreleased]` in `CHANGELOG.md` into a new
   `## [X.Y.Z] — YYYY-MM-DD` section. Leave `Unreleased` empty.
2. Bump the version in the three files above (keep them identical).
3. Commit: `Release vX.Y.Z: <one-line summary>`.
4. Tag **annotated**, with the changelog entry as the message:
   `git tag -a vX.Y.Z -m "<notes>"` — the CI turns this into the GitHub
   release body.
5. `git push && git push origin vX.Y.Z`. CI (`.github/workflows/release.yml`)
   builds, signs, and publishes the installer, `latest.json`, checksums,
   and the stable `nexalix-agora-setup.exe`.

Never hand-publish a release the CI can produce; never bump a version
without a matching CHANGELOG entry.

## Commits

Small, focused commits. Imperative subject (`Add …`, `Fix …`, `Refactor …`).
Do not push directly to `main` for large work — branch and open a PR.

## Code

- **Rust** (`src-tauri/`): must pass `cargo fmt --check` and
  `cargo clippy --all-targets --all-features -- -D warnings`. No
  `unwrap`/`expect`/`panic!` on runtime paths (enforced by
  `[lints]` in `Cargo.toml`). Run the `rust-clean-code` checklist.
- **Frontend** (`src/`): `pnpm build` (runs `tsc`) must be clean. Vanilla
  TypeScript, no framework. Keep the launcher quiet and keyboard-first.
- User-facing strings go through `src/i18n.ts` (EN is the source of truth;
  other languages fall back to EN).

## Definition of done

`pnpm build` clean · Rust `fmt` + `clippy -D warnings` clean · CHANGELOG
updated · version files in sync · feature verified in the real app.
