# Package Manager Standard: ray-vault-sync

Status: PNPM 12.9.1 with Node 24.22.1.

## Current state

| Item | Observed state |
| --- | --- |
| Package manifest | `package.json`; `packageManager` pinned to `pnpm@12.9.1` |
| Lockfile | `pnpm-lock.yaml` |
| Local dependencies | `node_modules` directory |
| CI | `.github/workflows/ci.yml` and `.github/workflows/release.yml`, Node 24.22.1, frozen PNPM install |
| Project scripts | `pnpm run dev`, `pnpm run build`, and `pnpm test` |

PNPM is the sole package manager. Node 24.22.1 is the CI and release runtime.

## Contributor workflow

- Use `pnpm install --frozen-lockfile --ignore-scripts` for clean installs, then
  explicitly run `pnpm rebuild esbuild` for the approved build dependency.
- Keep `pnpm-lock.yaml` synchronized with `package.json`.
- Use Node 24.22.1 for local validation and CI parity.
- `package.json` pins patched `esbuild`; `pnpm-workspace.yaml` pins fixed
  versions of vulnerable transitive build/test dependencies. Keep the lockfile aligned and
  revisit each override when its parent dependency is upgraded.
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

## Security audit

The 2026-11-09 dependency audit has no high, critical, or moderate findings.
One low finding remains: `deepmerge@4.3.1`, reached through Jest's
`jest-config`, has a prototype poisoning advisory with no patched release.
It is development-only and is not bundled into the plugin. Owner: Ray; recheck
when Jest is upgraded and keep the finding visible until upstream publishes a
fix.
