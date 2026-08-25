# Changelog

All notable changes to **Ray Vault Sync** will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-08-25

### Added
- **Gitless 3-Way Merge**: Complete cross-device vault synchronization via GitHub REST API without requiring a local Git installation or heavy WebAssembly libraries.
- **Zero Silent Data Loss Conflict Safety**: Preserves both local and remote versions with `.conflict-<timestamp>` files upon concurrent edits.
- **Batched Atomic Commits**: Groups vault changes into clean, structured single Git commits per sync batch.
- **Desktop & Mobile Support**: Full compatibility with Obsidian Desktop (macOS, Windows, Linux) and Mobile (iOS, Android).
- **Auto-Sync Interval**: Configurable background sync timer with safety debounce.
- **Diagnostics & Conflict Viewer**: In-app diagnostics command to test GitHub token permissions and detect diverged files.
- **Branding & Visual Assets**: Official logo, hero banner, and Buy Me a Coffee support badge integration.
