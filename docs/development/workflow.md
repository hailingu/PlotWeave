# Development Workflow

This document is the developer entry point for PlotWeave. It keeps repository structure, toolchain, branch policy, continuous integration, local gates, and delivery rules separate from the user-facing product README. Detailed gate behavior and engineering standards remain authoritative in the linked documents.

## Technology And Repository Layout

PlotWeave is a Tauri desktop application. React, TypeScript, and `@xyflow/react` own canvas interaction and document editing; Rust owns Tauri commands, persistence, preferences, media access, and native integration.

```text
PlotWeave/
├── .github/        # Pull-request and branch CI
├── .githooks/      # Versioned commit and push gates
├── scripts/        # Static, coverage, SonarQube, and guard scripts
├── src/            # React canvas and frontend application
├── src-tauri/      # Rust backend and Tauri shell
├── docs/           # Product design and engineering documentation
├── AGENTS.md       # Repository-wide contribution policy
└── README.md       # User-facing product introduction
```

Discover exact dependency versions and commands from `package.json`, `package-lock.json`, `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock`, `src-tauri/tauri.conf.json`, `.nvmrc`, and `rust-toolchain.toml`. Those versioned files take precedence over prose summaries.

## Local Setup

```bash
nvm use
npm install
cargo install cargo-llvm-cov
npm run hooks:install
export SONAR_HOST_URL=http://localhost:9000
# Export SONAR_TOKEN or PLOTWEAVE_SONAR_TOKEN when the service requires it.
npm run tauri dev
```

Never commit SonarQube credentials or other secrets. Use the URL and token for the developer's own environment.

Useful direct checks:

- Frontend and shared static checks: `npm run format:check && npm run lint && npm run typecheck:strict && npm run build`
- Frontend tests: `npm test`
- Rust checks from `src-tauri/`: `cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test`
- Complete local quality gate: `npm run sonar:gate`

## Branch And Pull-Request Model

`dev` is the development integration baseline. `main` is the enabled release branch.

- Create task branches from the current authorized `dev` checkout, using an appropriate `feature/`, `fix/`, `docs/`, or `chore/` prefix.
- Target ordinary task pull requests at `dev`.
- Only a repository integration or release pull request from `dev` may target `main`.
- Do not commit or push directly to `dev` or `main`.
- Require passing pull-request CI before integration. After merging `dev` into `main`, require the `main` push CI to pass before creating the version tag and GitHub Release at that exact merge commit.

These are repository collaboration rules. They do not assert that GitHub branch protection or rulesets are configured. Changing remote permissions or protection settings requires a separate owner decision.

## Pull-Request Continuous Integration (Issue #228)

`.github/workflows/ci.yml` runs for pull requests and pushes involving `dev` or `main` on the repository's configured macOS runner. Its frontend job checks Prettier formatting, ESLint with zero warnings, strict TypeScript, maintained-file size, the production build, frontend tests, and script/hook behavior tests. Its Rust job checks formatting, Clippy with warnings denied, and Rust tests.

Hosted CI does not run the local SonarQube scan because that service is not reachable from the hosted runner. Local coverage and SonarQube requirements remain mandatory and are not weakened by green CI. See [AGENTS.md](../../AGENTS.md) for scope routing and [Quality Gate Cost Decision](quality-gate-cost.md) for the accepted gate design.

## Commit And Push Gates

The versioned `pre-commit`, `pre-merge-commit`, `prepare-commit-msg`, and `pre-push` hooks run the same complete quality gate. At a high level it:

1. Runs formatting, lint, maintained-file size, and strict type checks.
2. Generates frontend and Rust coverage and enforces the versioned 80% overall line-coverage floor for each report.
3. Runs SonarQube, waits for an `OK` Quality Gate, and requires zero unresolved issues on new code.
4. Records the passing run through the repository's gate-evidence workflow.

A failed or unavailable required check blocks the Git operation. Do not use `--no-verify`, test injection variables, exclusions, or suppressions to evade the gate. The full command coverage, known boundaries, per-ref push behavior, evidence semantics, lock recovery, and cost decision are maintained in:

- [Gate Enforcement And Known Boundaries](quality-gate-enforcement.md)
- [Push-Path Per-Ref Gating](quality-gate-push.md)
- [Gate Lifecycle And Recovery](quality-gate-lifecycle.md)
- [Gate Run Evidence](quality-gate-evidence.md)
- [Quality Gate Cost Decision](quality-gate-cost.md)

## Versioning And Delivery

The first GitHub Release is `v0.2.0`, matching the application version already shared by the frontend, Rust, and Tauri configuration. It is a source-only release and makes no 1.0 stability promise. Passing frontend and Rust CI does not establish desktop distribution readiness.

For a later release:

1. Update `package.json`, `package-lock.json`, `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock`, and `src-tauri/tauri.conf.json` to one consistent application version, and add release notes in the same task pull request when a version change is needed.
2. Merge the prepared work into `dev`, then use a `dev` to `main` release pull request.
3. Wait for the `main` push CI to pass.
4. Create the version tag and GitHub Release at the verified `main` merge commit.

Before attaching desktop binaries, separately complete target-platform packaging, signing and notarization where applicable, install/launch verification, and native critical-flow acceptance. State the platform, architecture, checksum, and known limitations in the Release. Never describe an unverified artifact as an installable delivery.

There is currently no long-lived `release` branch. Published version tags identify immutable source snapshots; documentation corrections made after a tag appear in later commits and releases rather than rewriting published history.

## Engineering References

- [Software Engineering Standard](software-engineering-standard.md)
- [TypeScript Standard](typescript-standard.md)
- [Rust Standard](rust-standard.md)
- [Issue Standard](issue-standard.md)
- [File Size Guard](file-size-guard.md)
- [Data Model Index](../data-model/README.md)
- [UI Design Specification](../ui-design.md)
