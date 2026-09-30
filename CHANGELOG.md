# Changelog

All notable changes to **Ray Vault Sync** will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.3.0] - 2026-09-30

### Added
- **Local Error Log**: 50-entry redacted crash history stored on-device (no telemetry, no network calls). Survives app restarts to capture mobile startup errors.
- **Error Log Settings**: Copy / Clear buttons in plugin settings for manual sharing in GitHub issues.
- **Diagnostics Integration**: `Run Diagnostics` report now includes the last 10 redacted errors.

### Fixed
- **`this.formatRelativeTime` bug**: `src/mobile-widget.ts` called a non-existent method; now calls the standalone `formatRelativeTime()` function.
- **Unnecessary assertion**: `src/mobile-widget.ts` uses `querySelector<HTMLElement>()` instead of `as` cast.
- **Removed `console.error`**: `runSync` failures now go to the local error log (reviewer compliance).
- **Release attestations**: Build provenance now covers `main.js`, `manifest.json`, and `styles.css`.

## [1.2.0] - 2026-09-05

### Added
- **Mobile Sidebar Sync Card**: Touch-friendly sync button with live spinning status indicator at the top of the Left Sidebar (File Explorer).
- **Relative Last Sync Info**: Displays elapsed time since last sync (*"Baru saja"*, *"5m yang lalu"*, *"1j yang lalu"*) with auto-refresh every 30 seconds.
- **Mobile Sidebar Setting**: Configurable toggle in plugin settings to enable or disable the sidebar card.
- **Privacy & Vault Access Disclosure**: Added explicit vault enumeration documentation to README and source code for Obsidian reviewer transparency.

### Fixed
- **Unnecessary Type Assertion**: Removed redundant `as Uint8Array` assertion on `createBlob` in conflict resolution (`src/sync-core.ts`).
- **Release Assets**: Included `styles.css` in GitHub Release workflow so custom styles are packaged with releases.

## [1.1.0] - 2026-08-26

### Added
- **Excluded Folders / Patterns Setting**: Configurable comma-separated list of folders or file patterns to ignore during sync (e.g. `templates, private, archive, node_modules`).
- **Batched Tree Uploads (500 items/chunk)**: Inlines text file changes directly into `createTree` in chunks of 500 files, replacing thousands of sequential `createBlob` calls with atomic batch requests.
- **In-Memory File Content Cache**: Caches file content and hash during initial scan, completely eliminating redundant disk I/O and duplicate SHA computations.
- **GitHub Artifact Attestations**: Added cryptographic build provenance signing via `actions/attest-build-provenance@v2` in release workflow.

### Changed
- **Smart API Throttling**: Enforces 1-second delay between mutative requests according to GitHub secondary rate-limit guidelines without redundant delays.
- **Ignore Filter (`isIgnoredPath`)**: Automatically excludes `node_modules/`, hidden files/folders (`.*`), `sync-state.json`, and OS junk (`.DS_Store`, `Thumbs.db`).
- **Settings UI Compliance**: Removed prohibited heading texts ("General", "Settings", and plugin name) in accordance with Obsidian review guidelines.
- **Popout Compatibility**: Uses `window.setTimeout` and `window.setInterval` for seamless popout window support.

## [1.0.3] - 2026-08-26

### Added
- GitHub artifact attestations for release assets (cryptographic build provenance).
- Excluded Folders / Patterns setting: Configure comma-separated folders or paths to exclude from synchronization.

### Changed
- Smart throttle: only sleeps the remaining time to reach 1s between mutative API requests, instead of a flat 1s delay every time.
- Batched Tree Creation: Text file contents are now inlined directly into `createTree` in chunks of 500 files, eliminating thousands of individual `createBlob` calls.
- In-Memory File Cache: Eliminates redundant disk reads and duplicate SHA calculations during sync execution.
- Ignore Filter (`isIgnoredPath`): Automatically excludes `node_modules/`, hidden files/folders (`.*`), `sync-state.json`, and OS junk (`.DS_Store`, `Thumbs.db`).
- Settings UI: Removed "General" heading to comply with Obsidian reviewer guidelines.

## [1.0.2] - 2026-08-26

### Fixed
- Bump `minAppVersion` from `1.4.0` to `1.7.0` to match `fileManager.trashFile()` API requirement (since 1.6.6).
- Settings heading no longer includes plugin name or the word "Settings" (Obsidian review rules).
- Use `window.setTimeout()` instead of `setTimeout()` for popout window compatibility.
- Fix unsafe `any` assignment in `loadSettings()` — cast to `Partial<RayVaultSyncSettings>`.
- Replace `any[]` return type on `getSettingDefinitions()` with `never[]`.
- Remove unused `_` catch variables.

## [1.0.1] - 2026-08-26

### Added
- Concurrency lock (`isSyncing` mutex) prevents overlapping sync operations.
- Smart cooldown backoff when GitHub rate limit is hit — reads `Retry-After` / `x-ratelimit-reset` headers.
- Live progress indicator on Obsidian status bar during sync (e.g. `Processing 5/60: UPLOAD...`).
- 1-second throttle between mutative GitHub API requests per GitHub's secondary rate limit best practices.

### Changed
- Replaced `fetch` with Obsidian's `requestUrl` API for mobile & CORS compatibility.
- Replaced deprecated `escape()`/`unescape()` with `TextEncoder`/`TextDecoder` for Base64 encoding.
- Replaced hardcoded `.obsidian` config path with `app.vault.configDir`.
- Replaced `Vault.trash()` with `FileManager.trashFile()` for OS-level trash preference.
- Settings UI uses `new Setting().setHeading()` instead of raw HTML.
- All `catch (e: any)` replaced with `catch (e: unknown)` + `instanceof Error` checks.
- All unawaited Promises prefixed with `void`.
- `builtin-modules` dependency replaced with native `module.builtinModules`.
- Diagnostics report writes to `Sync Diagnostics.md` instead of `console.log`.
- README cleaned up: all emojis removed for a professional look.

## [1.0.0] - 2026-08-25

### Added
- **Gitless 3-Way Merge**: Complete cross-device vault synchronization via GitHub REST API without requiring a local Git installation or heavy WebAssembly libraries.
- **Zero Silent Data Loss Conflict Safety**: Preserves both local and remote versions with `.conflict-<timestamp>` files upon concurrent edits.
- **Batched Atomic Commits**: Groups vault changes into clean, structured single Git commits per sync batch.
- **Desktop & Mobile Support**: Full compatibility with Obsidian Desktop (macOS, Windows, Linux) and Mobile (iOS, Android).
- **Auto-Sync Interval**: Configurable background sync timer with safety debounce.
- **Diagnostics & Conflict Viewer**: In-app diagnostics command to test GitHub token permissions and detect diverged files.
- **Branding & Visual Assets**: Official logo, hero banner, and Buy Me a Coffee support badge integration.
