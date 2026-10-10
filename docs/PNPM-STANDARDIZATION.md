# Package Manager Standard: ray-vault-sync

Status: Migrated to PNPM 12.9.1 on Node 20.

## Current state

| Item | Observed state |
| --- | --- |
| Package manifest | `package.json`; `packageManager` pinned to `pnpm@12.9.1` |
| Lockfile | `pnpm-lock.yaml` |
| Local dependencies | `node_modules` directory |
| CI | `.github/workflows/ci.yml` and `.github/workflows/release.yml`, Node 20, frozen PNPM install |
| Project scripts | `pnpm run dev`, `pnpm run build`, and `pnpm test` |

PNPM is the sole package manager. Node 20 remains the CI and release runtime.

## Contributor workflow

- Use `pnpm install --frozen-lockfile` for clean installs.
- Keep `pnpm-lock.yaml` synchronized with `package.json`.
- Keep Node 20 unless Node compatibility is separately reviewed.
- `pnpm-workspace.yaml` allows the `esbuild` install script because it fetches
  the platform binary required for builds. Do not broadly allow dependency
  scripts without reviewing their need.
- Do not share `node_modules` with another repository through a manual symlink.

## Validation

CI installs from the pinned lockfile with package lifecycle scripts disabled,
then explicitly rebuilds the approved `esbuild` dependency before running tests
and producing an LCOV coverage report and plugin build. Publishing is blocked until the
`RELEASES_ENABLED` repository variable is explicitly set to `true`; tag pushes
during the freeze intentionally fail instead of producing a release.
