# Contributing to Ray Vault Sync

Thank you for your interest in contributing to **Ray Vault Sync**! We welcome bug reports, feature requests, and pull requests.

## Code of Conduct
Please be respectful, constructive, and friendly when interacting with fellow contributors and users.

## Development Setup

1. **Clone the repository**:
   ```bash
   git clone https://github.com/ufebri/ray-vault-sync.git
   cd ray-vault-sync
   ```

2. **Install dependencies** (Node.js 20 and pnpm 12.9.1):
   ```bash
   pnpm install --frozen-lockfile
   ```

3. **Build the plugin**:
   ```bash
   # Development watch mode
   pnpm run dev

   # Production build
   pnpm run build
   ```

4. **Run Automated Tests**:
   ```bash
   pnpm test
   ```

Pull requests run tests with coverage, build the plugin, and run SonarCloud analysis after automatic analysis is disabled for the project. Maintainers must configure the `SONAR_TOKEN` Actions secret and provide `SONAR_ORGANIZATION` and `SONAR_PROJECT_KEY` as repository variables or secrets. The SonarCloud job fails clearly if this configuration is missing. Fork pull requests skip SonarCloud because GitHub does not provide repository secrets to untrusted fork workflows; that is an explicit exception, so review fork changes on a trusted branch before merging. See [SonarCloud setup](docs/SONARCLOUD.md) for onboarding, required branch checks, and finding-resolution policy.

The release workflow blocks publishing unless the `RELEASES_ENABLED` repository variable is explicitly set to `true`; a matching tag while frozen deliberately produces a failed workflow. Do not create release tags during the freeze.

## Local Testing with Obsidian

1. Create or open an empty test Obsidian vault.
2. In the test vault, ensure the directory exists:
   `.obsidian/plugins/ray-vault-sync/`
3. Copy or symlink `main.js`, `manifest.json`, and `assets/` into that folder.
4. In Obsidian: **Settings > Community plugins > Reload**, then enable **Ray Vault Sync**.

## Guidelines & Architecture Constraints

- **Mobile API Compliance**: Do NOT use Node.js desktop-only modules (`fs`, `path`, `child_process`, `crypto` node module). Always use Obsidian's `Vault` API, `requestUrl` from `'obsidian'`, and Web Crypto APIs.
- **Obsidian API Standards**:
  - Never use browser `fetch` (forbidden by review guidelines).
  - Use `new Setting(containerEl)` for UI elements; avoid setting inline `style` attributes directly.
  - Do not use "Settings", "General", or the plugin name in settings tab headings.
  - Use `window.setTimeout()` and `window.setInterval()` for popout window compatibility.
  - Use `app.fileManager.trashFile()` for user-configured trash handling.
- **No Silent Data Loss**: Any change to conflict reconciliation logic must preserve user content under all circumstances. Never force-overwrite a remote or local change without preservation.
- **Secondary Rate-Limit Safety**: Always throttle mutative GitHub API requests (`POST`, `PATCH`, `PUT`, `DELETE`) with at least 1-second delays.
- **Strict Semantic Versioning (SemVer 2.0.0)**:
  - Do NOT bump versions during local development or debugging. Keep version frozen during iterations.
  - **PATCH (`x.y.Z+1`)**: Bug fixes, reviewer compliance fixes, small internal performance tweaks (backward-compatible).
  - **MINOR (`x.Y+1.0`)**: New features or new user-facing settings (backward-compatible).
  - **MAJOR (`X+1.0.0`)**: Breaking architectural changes or incompatible data format migrations.
  - Version bumps require updating `package.json`, `manifest.json`, `versions.json`, and `CHANGELOG.md` simultaneously.
