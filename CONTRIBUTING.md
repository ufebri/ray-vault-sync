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

2. **Install dependencies**:
   ```bash
   npm install
   ```

3. **Build the plugin**:
   ```bash
   # Development watch mode
   npm run dev

   # Production build
   npm run build
   ```

4. **Run Automated Tests**:
   ```bash
   npm test
   ```

## Local Testing with Obsidian

1. Create or open an empty test Obsidian vault.
2. In the test vault, ensure the directory exists:
   `.obsidian/plugins/ray-vault-sync/`
3. Copy or symlink `main.js`, `manifest.json`, and `assets/` into that folder.
4. In Obsidian: **Settings > Community plugins > Reload**, then enable **Ray Vault Sync**.

## Guidelines & Architecture Constraints

- **Mobile API Compliance**: Do NOT use Node.js desktop-only modules (`fs`, `path`, `child_process`, `crypto` node module). Always use Obsidian's `Vault` API, `requestUrl`/`fetch`, and Web Crypto APIs.
- **No Silent Data Loss**: Any change to conflict reconciliation logic must preserve user content under all circumstances. Never force-overwrite a remote or local change without preservation.
- **Strict Semantic Versioning**: Follow SemVer 2.0.0 (`MAJOR.MINOR.PATCH`).
