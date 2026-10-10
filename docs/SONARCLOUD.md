# SonarCloud setup and quality gate

This project uses CI-based SonarQube Cloud analysis from GitHub Actions so that
the Jest LCOV report is imported. Automatic Analysis must be disabled in the
SonarCloud project before the scanner runs; SonarCloud rejects CI-based
analysis while Automatic Analysis is enabled.

## Repository configuration

1. In the project's **Administration → Analysis Method**, turn
   **SonarQube Cloud Automatic Analysis** off and select GitHub Actions as the
   supported analysis method.
2. Confirm the project is bound to the GitHub repository
   `ufebri/ray-vault-sync` and pull request analysis is enabled.
3. Require both `verify` and `SonarCloud Code Analysis` checks on the default
   branch before merging changes.
4. Ensure the repository secrets `SONAR_TOKEN`, `SONAR_ORGANIZATION`, and
   `SONAR_PROJECT_KEY` are configured.
5. After disabling Automatic Analysis, add the repository variable
   `SONAR_CI_ENABLED=true` to enable the scanner step.
6. Run CI for the default branch and confirm the `coverage` measure is present
   in SonarCloud, not only that the Quality Gate passes.

`sonar-project.properties` points the scanner at `coverage/lcov.info`, which
the Jest test step must generate before analysis. Pull requests from forks do
not receive repository secrets; do not expose `SONAR_TOKEN` to untrusted code.
The scanner step runs on `main` and same-repository pull requests only.

Do not create a version tag while the release freeze is active.

## Resolving findings

- Fix confirmed bugs, vulnerabilities, security hotspots, and maintainability
  findings in source or tests.
- Do not suppress rules, exclude production code, or mark issues accepted or
  false-positive just to turn the gate green.
- If a rule is demonstrably incorrect for this code, document the evidence and
  obtain maintainer review before changing issue status or project policy.

SonarCloud owns the analysis check; branch protection requires that check
alongside `verify` so merges wait for the Quality Gate.
