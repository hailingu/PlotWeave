# Development Workflow

This document is the developer entry point for PlotWeave. It keeps repository structure, toolchain, branch policy, continuous integration, local gates, and delivery rules separate from the user-facing product README. Detailed gate behavior and engineering standards remain authoritative in the linked documents.

## Technology And Repository Layout

PlotWeave v0.3.0 publishes the existing SwiftUI/AppKit and React Flow implementation as source. The Tauri/React Flow/Rust application remains a retained baseline. SwiftUI owns the business interface, AppKit owns window and system integration, and Swift services own project storage, library assets, preferences, encrypted keys, and model requests. React, TypeScript, and `@xyflow/react` retain the single editing session, graph commands, undo/redo, and canvas inside WKWebView. The native application uses the existing typed IPC contracts without linking Rust or the historical C ABI; current capability and verification boundaries are recorded in [Feature Parity](../swiftui-react-flow-feature-parity.md). The native application was developed on the historical branch `codex/swiftui-react-flow`, whose content merged into `dev` through [PR #526](https://github.com/hailingu/PlotWeave/pull/526) on 2026-10-13; that branch no longer exists on the remote.

```text
PlotWeave/
├── .github/        # Pull-request and branch CI
├── .githooks/      # Versioned commit and push gates
├── scripts/        # Static, coverage, SonarQube, and guard scripts
├── src/            # React canvas and frontend application
├── src-tauri/      # Retained Tauri application and Rust domains
├── crates/         # Rust core used by Tauri; historical P2 C ABI
├── native/         # SwiftUI/AppKit application, Swift services, WKWebView canvas
├── docs/           # Product design and engineering documentation
├── AGENTS.md       # Repository-wide contribution policy
└── README.md       # User-facing product introduction
```

Discover exact dependency versions and commands from `package.json`, `package-lock.json`, `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock`, `crates/Cargo.toml`, `crates/Cargo.lock`, `src-tauri/tauri.conf.json`, `.nvmrc`, and `rust-toolchain.toml`. Those versioned files take precedence over prose summaries.

## Local Setup

### Supported Platforms

The only supported platform is **macOS**; **Windows is not supported**. Application runtime, the development toolchain, commit/push gates, and releases make no Windows compatibility commitment. Repository builds and CI are verified only on macOS; Linux likewise has no build or test coverage in this repository. Using Unix process groups does not imply support for every Unix platform.

Non-Unix platforms are source-only: the repository sources remain compilable for non-Unix targets ([issue #546](https://github.com/hailingu/PlotWeave/issues/546)), and users who need a Windows version must build it themselves at their own risk. Platform capability differences (such as the Unix file-identity and directory-persistence barrier primitives required by the library asset deletion/restoration protocol) are rejected at runtime when the capability is unavailable and receive no official verification. This section moves the platform details from the [README](../../README.md) here ([issue #772](https://github.com/hailingu/PlotWeave/issues/772)) without expanding the existing support scope.

Under the owner's disposition in [issue #503](https://github.com/hailingu/PlotWeave/issues/503), the installation supervisor rejects Windows slow-path pushes. Even when the fast path does not trigger that rejection, it is not a supported Windows workflow; contributors must run the complete gates and push from macOS. See [Platform Support Scope And Dependency Process Contract](quality-gate-push.md#平台支持范围与依赖进程契约issue-503) for the exact consequences and lifecycle-dependent process constraints.

### Node.js Minimum And Runtime Versions

The project supports Node.js `^24.18.0 || >=26.0.0`, as defined by `engines.node` in `package.json`; the root package metadata in the lockfile stays consistent. The minimum remains 24.18.0: supported versions are 24.x at 24.18.0 or later, or 26.0.0 and later. Vitest 5, introduced by #761, does not support Node 25 upstream, so the project range excludes 25 as well and avoids a contradiction between `engine-strict` installation and the declared range. `.nvmrc` remains `24.18.0`, allowing `nvm use` and CI to reproduce the same runtime. On first use, run `nvm install` to install that version and then `nvm use`; when using another supported version, record the actual version with `node --version` before verification. `scripts/node-engine.test.ts` uses the semver parser from the lockfile to verify boundaries such as 24.18/25/26 and dependency engine compatibility. This does not mean the full regression suite has been run on every supported runtime; current acceptance uses 24.18.0.

The [official Node.js release record](https://nodejs.org/en/blog/release/v24.18.0) confirms that `24.18.0` has been published. All four CI jobs select the project runtime through `actions/setup-node` with `node-version-file: .nvmrc`; `gate-evidence` reads `.nvmrc` from the event base commit under the existing trust boundary. An Action's commit SHA, major version, and own execution environment are independent tool configuration, not the project's Node.js minimum requirement. This clarification ([issue #745](https://github.com/hailingu/PlotWeave/issues/745)) upgrades neither Actions nor dependencies.

### Tauri Baseline Development Environment

```bash
nvm use
npm install
cargo install cargo-llvm-cov
export SONAR_HOST_URL=http://localhost:9000
# Export SONAR_TOKEN or PLOTWEAVE_SONAR_TOKEN when the service requires it.
npm run tauri dev
```

Never commit SonarQube credentials or other secrets. Use the URL and token for the developer's own environment.

`npm install` (and `npm ci`) runs the `prepare` lifecycle script `scripts/install-hooks.mjs`, which wires `core.hooksPath` to the versioned `.githooks/` automatically in any non-CI Git checkout ([issue #725](https://github.com/hailingu/PlotWeave/issues/725)); environments that set `CI` skip the wiring because hosted runners never create commits through local hooks. Until dependencies are first installed, or if the wiring reported `[HOOKS_INSTALL_FAILED]`, run `npm run hooks:install` as the manual fallback.

Useful direct checks:

- Frontend and shared static checks: `npm run format:check && npm run lint -- --max-warnings=0 && npm run typecheck:strict && npm run build`
- Frontend tests: `npm test`
- Maintained source size: `npm run check:size` (includes extracted Rust crates and native Swift sources).
- Rust checks from either `src-tauri/` or `crates/`: `npm --prefix .. run check:size && npm --prefix .. run check:workspace-drift && cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test` (the same command set and order as the `src-tauri/**` and `crates/**` Scope Routing rows in `AGENTS.md`; `check:workspace-drift` is the dual-workspace dependency drift guard from [issue #549](https://github.com/hailingu/PlotWeave/issues/549), which the hosted Rust CI job also runs before its Cargo checks).
- Complete local quality gate: `npm run sonar:gate`

Gate-workflow regression imports the explicitly approved historical Git objects from the local repository and requires a full Git clone, as used by frontend CI. Source archives remain usable for the source-build commands; the history-dependent regression requires the clone's Git objects.

### Native Application Launch And Verification

On 2026-10-07, the complete source from the archived worktree was restored and merged into the current primary tree; the build entry no longer points to the early demo shell. See the [integration record](../swiftui-react-flow-integration.md) for provenance, coordination of overlapping changes, and this verification.

The native application on the current `dev` branch implements the SwiftUI project home, toolbar, outline, property inspector, story settings, library, AI, export, and application settings interfaces, together with Swift storage, asset, preferences/key, and model services. Swift handles 27 business commands and two exit commands, totaling 29 snake_case IPC commands, plus the `system.copyText` and `system.saveText` system delivery commands. React retains the single editing session, history, and canvas; the default resource entry runs the production application, and only an explicit `#fixture` loads a non-persistent in-memory demo. See the [feature parity record](../swiftui-react-flow-feature-parity.md) for current behavior and the test matrix; the former P1/P2 status is retained only as [historical evidence](../swiftui-react-flow-p1-evidence.md) and in the [historical Rust extraction record](../swiftui-react-flow-p2-evidence.md).

macOS 26.0+, Node.js `^24.18.0 || >=26.0.0`, and Xcode 27.0/macOS SDK 27.0 are required; Rust is not required to build the native application. See the previous section for runtime version selection. The Swift 6.4 compiler remains in Swift 6 language mode; the owner's upgrade decision, measured versions, and build/launch results are in the [current toolchain record](../swiftui-react-flow-toolchain.md). If dependencies are not installed, run `npm install` first; its `prepare` lifecycle wires the versioned Git hooks automatically as described above.

The build toolchain is pinned to Xcode 27.0 and macOS SDK 27.0, the project remains in Swift 6 language mode, and the minimum deployment target remains macOS 26.0. Before building, confirm the selected toolchain with `xcodebuild -version` and `xcrun --sdk macosx --show-sdk-version`; the actual system version, compiler, and verification boundaries are in the [Xcode 27 toolchain record](../swiftui-react-flow-p1-evidence.md#xcode-27-工具链同步2026-10-07).

```bash
nvm use
npm run build:native
open -n native/macos/build/DerivedData/Build/Products/Debug/PlotWeaveNative.app
```

`build:native` builds the canvas resources and then the native application. `open -n` launches a new instance of this build; rebuilding does not automatically replace resources in windows that are already running. A standalone `xcodebuild build` does not rebuild the canvas resources, and the application reports a diagnostic when they are missing; run `npm run build:native-canvas` before debugging with Xcode ⌘R. The resources use an IIFE classic script and separate CSS for WKWebView `file://` loading, and the standalone entry includes the base React Flow styles.

To investigate drag rendering latency, run `PLOTWEAVE_CANVAS_PROFILE=1 npm run build:native`, then quit the old instance, launch the new build, and enable the performance diagnostics in the canvas's lower-left corner. This explicit mode uses the React production profiling renderer, and its reports distinguish the editor as a whole from the canvas subtree; ordinary builds keep Profiler disabled by default. See [Canvas Performance Diagnostics](canvas-performance-diagnostics.md) for metric boundaries, rerun procedures, and test evidence.

The local native data root is under Application Support as `BundleID + ".development"`, currently `dev.plotweave.PlotWeaveNative.development`; it is opened only on the first real request. It reads neither the legacy Tauri data root nor the historical Keychain. Tests inject temporary roots, synthetic keys, and transports rather than using the real development directory. Do not run multiple instances that write to the same root concurrently; this implementation remains scoped to a single user and a single instance.

Run native routing verification from the repository root with `npm run check:size && sh scripts/test-native.sh`. The shared TestAction selects an inert host before launch; real windows, focus, and exit delegates share `NSApplication`, so functional regression runs serially to isolate fixtures, as recorded in the [PR #526 fix record](../swiftui-react-flow-pr526-fixes.md). In PR #604 (2026-10-18), the owner chose to retain functional regression routinely and run stress tests on demand: `sh scripts/test-native.sh stress` separately runs sustained performance, long-loop memory, and first-drag measurements, preserving the original scale and assertions; see [Native Regression And Stress](quality-gate-push.md#native-regression-and-stress) for the selection boundary. Regression covers real WKWebView production pages and fixtures, the session bridge, storage, media, preferences, model transport, and exit; checking only that resources are bundled is insufficient. Real public-network TLS trust chains, model billing, actual system panels, visuals, Chinese input methods, VoiceOver, and trackpad performance remain unaccepted; see the [feature parity record](../swiftui-react-flow-feature-parity.md) for details. Both `native/macos/build/` and `native/macos/App/WebCanvas/` are ignored generated artifacts; delete pure verification output before task completion and delete local run build output after use.

## Branch And Pull-Request Model

`dev` is the development integration baseline. `main` is the enabled release branch.

- Create task branches from the current authorized `dev` checkout, using an appropriate `feature/`, `fix/`, `docs/`, or `chore/` prefix.
- Target ordinary task pull requests at `dev`.
- Only a repository integration or release pull request from `dev` may target `main`.
- Do not commit or push directly to `dev` or `main`.
- Require passing pull-request CI before integration. After merging `dev` into `main`, require the `main` push CI to pass before creating the version tag and GitHub Release at that exact merge commit.

These repository collaboration rules are backed by GitHub branch protection, which is enabled for both `dev` and `main` (owner decision, [issue #548](https://github.com/hailingu/PlotWeave/issues/548), 2026-10-16): a pull request is required, the four `ci` jobs — `frontend`, `rust`, `native`, and `gate-evidence` — are required status checks, administrators are included in enforcement, and force pushes and branch deletions are blocked. The authoritative policy statement is [AGENTS.md](../../AGENTS.md); changing remote permissions or protection settings still requires a separate owner decision.

## Pull-Request Continuous Integration (Issue #228)

`.github/workflows/ci.yml` runs for pull requests and pushes involving `dev` or `main` on the repository's configured macOS runner. Its frontend job checks Prettier formatting, ESLint with zero warnings, strict TypeScript, maintained-file size, the production build, and frontend tests; the script/hook behavior tests run inside that same default suite, because Vitest's default discovery already includes `scripts/**/*.test.ts`, so the former duplicate `npm test -- scripts` step was removed (issue #617). It also runs `npm audit --audit-level=high` as a blocking step (issue #618 ends the initial #552 warning period): high/critical findings or audit execution failures fail the frontend job; the full lockfile, including dev dependencies, remains in scope. Since issue #741 (plan A) that step runs through `scripts/ci-npm-audit.sh`: when npm reports that the advisory endpoint could not be used (`audit endpoint returned an error`, the diagnostic every observed timeout, 5xx, connection-refused and DNS failure ends with — the 2026-10-22 03:08–03:19 UTC registry window failed #707, #710 and #713 this way), the wrapper retries up to three more times with doubling delays (30s, 60s, 120s; `PLOTWEAVE_AUDIT_MAX_ATTEMPTS` / `PLOTWEAVE_AUDIT_RETRY_BASE_SECONDS` override the defaults for tests and operations) and fails closed with `[NPM_AUDIT_EXHAUSTED]` once the budget is spent; a real high/critical finding or any other nonzero audit result exits on the first attempt without a retry, the audit still runs before `npm ci`, and npm's own fetch timeout stays at its default, so the worst case is four ~5-minute timeouts plus 210 seconds of backoff. A future npm wording change would only make the wrapper stop retrying — it cannot turn an execution failure into a pass. `scripts/ci-npm-audit.test.ts` drives the wrapper with real npm against a loopback registry stub for each of these paths. Its Rust job checks the shared-kernel dependency drift guard (`npm run check:workspace-drift`, issue #549: `plotweave-core`'s resolved dependency closure must agree between the two Cargo workspaces), then formatting, Clippy with warnings denied, and Rust tests in both `src-tauri/` and `crates/`. Before its `src-tauri` `cargo test` it installs frontend dependencies and builds the frontend bundle (`npm ci` + `npm run build`, issue #551): the `frontend_bundle_chain` integration test drives the real `dist/` build through a real Wry webview over IPC into real persistence, and it self-skips with a notice when `dist/` is absent — locally that keeps the routed Rust checks runnable without a prior frontend build, while in CI the build steps guarantee the case always runs. It also audits both workspace lockfiles with `cargo audit` (issue #552, installed via a commit-pinned `taiki-e/install-action` with an exact scanner version, issue #618): vulnerability advisories fail the job, while informational warnings (unmaintained, unsound, yanked) do not. The frontend and Rust jobs use `macos-15`; the native job uses `xcode-27`, sets `DEVELOPER_DIR` to `/Applications/Xcode_27.0.app/Contents/Developer`, and verifies Xcode `27.0` and macOS SDK `27.0` before running `sh scripts/test-native.sh` (canvas build and serial functional regression; stress measurements are opt-in). The [official Xcode 27 image inventory](https://github.com/actions/runner-images/blob/main/images/macos/xcode-27-arm64-Readme.md) lists that version alias and SDK when checked on 2026-10-07; the [runner announcement](https://github.com/actions/runner-images/issues/14404) identifies the image as a public preview. Since issue #548, a fourth job `gate-evidence` runs on `ubuntu-latest` for pull requests only: `scripts/verify-gate-evidence.ts` checks every commit in the PR range except the tip against the versioned gate ledger at the PR head. Since issue #593 the job checks out the event base SHA (including its Node version and verifier), fetches the head only as Git objects, and passes exact base/head SHAs; replacing the verifier in the PR cannot neutralize the check. The workflow definition remains PR-controlled and the ledger remains an unsigned self-report, so this is evidence consistency rather than proof that a local gate ran (the tip's own record lags one commit and only warns; semantics in [Gate Run Evidence](quality-gate-evidence.md#server-side-evidence-verification-issue-548)). These configured jobs require their own passing CI runs; local results do not establish hosted CI status.

The native job also collects App Swift line counts through the public test entry (issue #601), appends a per-file table to its GitHub step summary, and uploads `coverage-summary.json`, `coverage-summary.md`, and raw `xccov.json` as `native-coverage-<run_attempt>`. Collection is mandatory; the initial percentage policy is report-only, with an optional explicit floor. Tests and WebKit JavaScript are outside this metric. See [Native Coverage](native-coverage.md) for inventory gaps, failure behavior, and local commands.

Frontend coverage also requires 80% lines independently for each production module under `src/editor/nativeCanvas/` (issue #616), in addition to the existing aggregate 80%. Mandatory local coverage runs enforce this policy; the CI frontend job retains `npm test`, which checks the generated policy inventory and behavior tests without collecting coverage. See [Coverage Floor And Baseline](typescript-standard.md#coverage-floor-and-baseline) for the pinned-provider implementation and reused-LCOV boundary.

Hosted CI does not run the local SonarQube scan because that service is not reachable from the hosted runner. Local coverage and SonarQube requirements remain mandatory and are not weakened by green CI; the hosted `gate-evidence` job verifies the ledger evidence those local runs leave behind, and GitHub branch protection on `dev`/`main` (issue #548; see [Branch And Pull-Request Model](#branch-and-pull-request-model) above) requires a pull request plus these four passing checks, rejecting direct pushes such as `git push --no-verify`. See [AGENTS.md](../../AGENTS.md) for scope routing and [Quality Gate Cost Decision](quality-gate-cost.md) for the accepted gate design.

## Dependency And Supply-Chain Visibility (Issue #552)

Dependabot (`.github/dependabot.yml`) opens weekly pull requests for the npm root manifest, the two Cargo workspaces (`src-tauri/` and `crates/`), and GitHub Actions, all targeting `dev`. npm first groups the React family (`react`, `react-dom`, and their two type packages), Vite family (`vite`, `@vitejs/plugin-react`), and Vitest family (`vitest`, `@vitest/coverage-v8`) across all update levels. These groups precede the general minor/patch group, so exact peer pairs also stay together during minor/patch updates. Remaining minor/patch updates are grouped per ecosystem; remaining majors stay separate for deliberate generational review. The pinned toolchains (`.nvmrc`, `rust-toolchain.toml`) belong to none of these ecosystems and are untouched. The native application has no third-party Swift package dependencies, so this ecosystem set covers the repository's dependency surface. Dependabot never merges: its pull requests run the same required ci.yml checks as any other pull request, and the `rust` job's `cargo audit` blocks a dependency PR that would introduce a vulnerable crate version.

The [#761](https://github.com/hailingu/PlotWeave/issues/761) migration coordinates React/DOM 19.3.1 and types 19.3.0, Vite 8.3.5/plugin-react 6.1.2, and Vitest/coverage-v8 5.0.5. Vite 8 uses Rolldown: the native file entry keeps its IIFE and flat relative resources through `rolldownOptions` with code splitting disabled. Only `react-dom/client` is redirected for profiling; React 19's profiling renderer imports the unchanged root `react-dom` shared state used by `flushSync`. Existing production bundle probes and native WKWebView regression exercise that boundary. The Vitest provider migration retains both line-coverage floors and the existing source/exclusion inventory; see [Coverage Floor And Baseline](typescript-standard.md#coverage-floor-and-baseline).

The TypeScript generation stays on the last `typescript-eslint`-compatible line ([issue #784](https://github.com/hailingu/PlotWeave/issues/784)): `typescript` moved 5.9.3 → 6.0.3 with an explicit `~6.0.3` range mirroring `typescript-eslint` 8.72's `>=4.8.4 <6.1.0` peer ceiling, so the root `npm ci` resolves cleanly without `--legacy-peer-deps` or overrides and a future 6.1 release cannot re-create the ERESOLVE failure class. TypeScript 6 additionally reports undeclared side-effect style imports (TS2882); `src/vite-env.d.ts` declares `*.css` ambiently for the existing style imports, which Vite resolves at build time. The TypeScript 7 (native compiler) jump Dependabot proposed in [#777](https://github.com/hailingu/PlotWeave/pull/777) remains blocked upstream — `typescript-eslint` support is tracked in [typescript-eslint#12518](https://github.com/typescript-eslint/typescript-eslint/issues/12518) (closed as a duplicate of [#10940](https://github.com/typescript-eslint/typescript-eslint/issues/10940), pending a TS 7 API) — and #777 was closed with `@dependabot close` as the explicit waiting-period disposition; the migration follows #784's draft approach once an upstream release widens the peer range.

Grouping creates a review unit, not a compatibility guarantee: future generations may still require a coordinated migration across groups, and installation, build, tests, coverage, audit and review continue to block incompatible proposals. GitHub reads this configuration from the default branch `main`; merging the #761 configuration into `dev` alone does not activate the groups on the bot service. Updating `main` requires a separately authorized integration; local YAML tests do not establish live-service adoption.

Known boundary (PR #582 review, P2): `target-branch: dev` binds only the version updates configured in `dependabot.yml`. Dependabot security updates are a separate repository-settings feature — currently **disabled** on this repository — whose pull requests always target the default branch (`main`) by platform behavior that no configuration redirects ([GitHub docs](https://docs.github.com/en/code-security/tutorials/secure-your-dependencies/customizing-dependabot-prs#targeting-pull-requests-against-a-non-default-branch)). If the owner ever enables that feature, a security-update pull request against `main` must not be merged as-is, because it bypasses the branch policy that only `dev`-to-`main` release pull requests may target `main`: close it and re-apply the fix on a task branch targeting `dev`, or record an explicit owner decision accepting the exception. The CI audit steps remain the pre-merge vulnerability gate on the `dev` path in either case.

A Dependabot pull request interacts with the `gate-evidence` required check as follows. Dependabot's default branch shape is a single force-pushed commit, so the PR range contains only the tip and the check passes through the tip-lag tolerance with a warning annotation (`[GATE_EVIDENCE_TIP_LAG]`). If a Dependabot branch accumulates non-tip commits without local gate records (for example after manual collaboration on the branch), `gate-evidence` fails by design; the maintainer then runs the local gate and pushes an evidence commit as documented in [Gate Run Evidence](quality-gate-evidence.md) before merging. No exemption from the evidence check is granted to bot actors.

### Cargo Multi-Directory Updates And Acceptance (Issue #732)

Cargo uses a single `package-ecosystem: cargo` entry whose `directories` covers exactly `/src-tauri` and `/crates`; both sides participate in the existing `cargo-minor-and-patch` update group. The target remains `dev`, the schedule remains every Monday in `Asia/Shanghai`, and the PR limit remains 5; the policy of grouping minor/patch updates and reviewing majors separately is unchanged. The configuration uses [GitHub's official multi-directory grouping mechanism](https://docs.github.com/en/code-security/tutorials/secure-your-dependencies/optimizing-pr-creation-version-updates#example-2-grouped-updates-with-excluded-dependencies).

The acceptance goal is for **a supported shared-dependency update PR generated by Dependabot itself to pass the corresponding CI**, including both lockfiles and any necessary shared manifest updates. The YAML-parsing configuration regression validates only the directory and grouping policy; it does not prove that the GitHub service has adopted the configuration or that the transitive dependencies resolved by the two independent Cargo resolvers necessarily match. Inspect the actual bot output, then accept the result through successful required `frontend`, `rust`, `native`, and `gate-evidence` checks on that PR's final head; manually added alignment commits cannot substitute for this goal.

GitHub [requires `dependabot.yml` to be read from the default branch](https://docs.github.com/en/code-security/concepts/supply-chain-security/about-the-dependabot-yml-file#where-to-store-the-dependabotyml-file). This repository's default branch is `main`; `target-branch: dev` selects only the version-update target and does not change where the configuration is read. Merging this change only into `dev` does not activate the multi-directory mechanism. Until a separately authorized integration updates the default-branch configuration, real bot-service acceptance remains pending, and #732 must not be closed on the basis of local configuration tests.

If actual updates still produce `DRIFT_VERSION_MISMATCH` or `DRIFT_CARGO_FAILED`, retain the block and diagnose the resolver, version constraints, and lockfiles. Exception handling must complete `src-tauri/Cargo.lock`, `crates/Cargo.lock`, and any necessary manifests in the same PR. In each workspace, run `cargo update --manifest-path <workspace>/Cargo.toml -p <package>@<old-version> --precise <compatible-version>` to align the package identified by the diagnostic, then run `npm run check:workspace-drift` to check the entire `plotweave-core` shared closure rather than only the updated direct dependency. Do not upgrade everything indiscriminately; if constraints are incompatible, keep the block and review the compatibility fix separately. Manually added commits must run the normal local commit/push gates and complete the gate evidence; this recovery resolves only that PR and does not establish acceptance of the bot-generated-output goal.

The drift check continues to use real `cargo tree --locked` results from both sides; differing shared-package version sets or manifests out of sync with their lockfiles fail the check, which must not modify the locks. The required `rust` check, auditing, branch protection, and evidence requirements remain unchanged: there are no bot exemptions, paired-PR approvals, post-merge alignment windows, or automatic fixes with newly granted write permissions.

### Scanner And Action Updates (Issue #618)

The scanner version and advisory data are separate inputs. `ci.yml` pins an exact `cargo-audit` release (0.22.2 at the 2026-10-19 change), while its normal audit commands refresh the RustSec advisory database. Do not replace the version with `latest`, freeze the database, add ignored advisories, or swallow scanner failures to obtain a green job. Informational `unmaintained`, `unsound`, and `yanked` reports retain their existing nonblocking policy; vulnerability advisories remain blocking.

Every remote Action in `ci.yml` is pinned to a full upstream commit SHA; the inline major-version comment is a maintenance label, not the execution reference. Initial pins are the exact five Action revisions executed by successful CI run [39220122278](https://github.com/hailingu/PlotWeave/actions/runs/39220122278), verified against their upstream repositories, with no major-version upgrade. The workflow file is the sole current pin inventory. This follows [GitHub's immutable Action reference guidance](https://docs.github.com/en/actions/reference/security/secure-use#using-third-party-actions).

Existing weekly Dependabot `github-actions` proposals still target `dev` and never merge automatically. Review the upstream release and commit diff, including permissions and input compatibility, and require the same real review and four CI checks before accepting a SHA update. Scanner upgrades are a separate explicit version edit after reviewing cargo-audit release notes and auditing both lockfiles. Neither a moving Action tag nor a floating scanner version is an update mechanism. Runner images, advisory data, and other existing workflow inputs still evolve; these pins do not claim bit-for-bit reproducibility of the entire CI environment or change the #593 workflow-definition trust boundary.

Validation on 2026-10-19: the full npm audit reports zero findings; official cargo-audit 0.22.2, checked against its published archive SHA256 and run twice with a freshly fetched RustSec database, reports zero vulnerabilities in both Cargo workspaces. The database commit is `999ec89d5d3f10f20be14750ec8c2d8b44e0ac9b` (1338 advisories). `src-tauri/Cargo.lock` has eleven informational warnings: unmaintained `proc-macro-error` (RUSTSEC-2024-0370), the `unic-*` family (RUSTSEC-2025-0075/0080/0081/0098/0100), `zbus_names` (RUSTSEC-2026-0371), `zvariant` (RUSTSEC-2026-0370), `zvariant_derive` (RUSTSEC-2026-0372), unsound `glib` (RUSTSEC-2024-0429), and yanked `chacha20` 0.10.1. The three newly reported unmaintained crates follow the same existing informational policy and remain for future dependency maintenance, without lockfile churn or new ignores here. `crates/Cargo.lock` has no warnings.

Validation on 2026-10-21 ([PR #680](https://github.com/hailingu/PlotWeave/pull/680)): refreshed advisory data correctly blocked the existing Vite 6.4.3 lock and the Tauri lock's rustls-webpki 0.103.15 / webpki-roots 1.0.9. The minimal compatibility update resolves Vite 6.4.4 ([launch-editor advisory](https://github.com/advisories/GHSA-587h-7wmj-h5pm)), rustls-webpki 0.103.16 ([RUSTSEC-2026-0382](https://rustsec.org/advisories/RUSTSEC-2026-0382.html)), and webpki-roots 1.0.10 ([RUSTSEC-2026-0381](https://rustsec.org/advisories/RUSTSEC-2026-0381.html)); manifest ranges, toolchains, scanner/action pins, thresholds and advisory-refresh behavior remain unchanged. Full npm audit and the same verified official cargo-audit 0.22.2 archive report zero blocking vulnerabilities in both Cargo workspaces against RustSec commit `e6f94f3760d5e6c54c1b05f204002263bc025524` (1348 advisories). The eleven Tauri informational warnings above remain under the existing policy; the core workspace still has none. This is a dated audit result, not a frozen database or a guarantee against later advisories.

An isolated known-high lodash 4.17.20 lockfile ran the parsed workflow audit command and exited 1 with one high finding; neither the step nor job has a continue-on-error exemption. The fixture installed no packages and all three project lockfiles remained byte-identical. This verifies the real command's failure and the workflow's propagation configuration; a deliberately vulnerable product lockfile was not pushed to hosted CI. Normal hosted CI must still pass on the actual dependency set. The locked YAML parser tests enforce these configuration contracts without matching source layout or documentation text. Since issue #741 that scenario is a committed regression rather than a one-off check: `scripts/ci-npm-audit.test.ts` writes an equivalent throwaway lockfile at test time (no vulnerable manifest is committed, so the dependency graph stays clean) and has a loopback registry stub answer real npm with a high advisory, a moderate advisory, an empty result, and transient or persistent endpoint failures, asserting the wrapper's exit status, request counts and retry delays for each case.

## Commit And Push Gates

The versioned commit-creating hooks (`pre-commit`, `pre-merge-commit`, `prepare-commit-msg`) run the complete quality gate. `pre-push` is scope-routed by owner decision 2026-10-18:

- **docs-only** (`docs/**`, root Markdown, `LICENSE`): only `scripts/check-docs.sh`; no static checks, coverage, Sonar, or push ledger record. The commit-gate record remains the evidence.
- **single implementation stack** (`frontend` = `src/**` and frontend-only root configs; `rust` = `src-tauri/**` + `crates/**` + `rust-toolchain.toml`; `native` = `native/**`): run that stack's full regression and full coverage; reuse the other frontend/Rust stack's most recent LCOV for Sonar. Native runs `sh scripts/test-native.sh` for serial functional regression, keeps stress measurements opt-in, and records that native code is outside Sonar.
- **cross-stack, tooling (`.githooks/**`, `scripts/**`, `.github/**`, root linters), unknown paths, empty ranges, or an undeterminable base**: fresh frontend/Rust coverage plus native functional regression before Sonar.

The complete gate at a high level:

1. Runs formatting, lint, maintained-file size, and strict type checks.
2. Generates frontend and Rust coverage and enforces the versioned 80% overall line-coverage floor for each report.
3. For every `full` push, also runs native functional regression. The three commit-creating entry points retain the frontend/Rust sequence.
4. Runs SonarQube, waits for an `OK` Quality Gate, and requires zero unresolved issues on new code.
5. Records the passing run through the repository's gate-evidence workflow.

The scoped push is fail-closed: a missing reused LCOV, unsupported scope, or classification error blocks the push. It is not an exemption from the commit gates. Details and boundaries are in [Scoped Push Routing](quality-gate-push.md#scoped-push-routing-2026-10-18) and [Scoped Push Cost](quality-gate-cost.md#scoped-push-cost-2026-10-18-owner-direction).

A failed or unavailable required check blocks the Git operation. Do not use `--no-verify`, test injection variables, exclusions, or suppressions to evade the gate. The full command coverage, known boundaries, per-ref push behavior, evidence semantics, lock recovery, and cost decision are maintained in:

- [Gate Enforcement And Known Boundaries](quality-gate-enforcement.md)
- [Push-Path Per-Ref Gating](quality-gate-push.md)
- [Gate Lifecycle And Recovery](quality-gate-lifecycle.md)
- [Gate Run Evidence](quality-gate-evidence.md)
- [Quality Gate Cost Decision](quality-gate-cost.md)
- [Gate Test Workload And Fixture Cost (Issue #498)](test-workload.md)

The owner approved one historical-base bootstrap on 2026-10-22: when the v0.3.0 same-repository `dev → main` release has exact old base `fbd298ebe6cfa1a9fab6e632c00cdede06d81faf`, which lacks the verifier, the evidence job uses the fixed already-reviewed `4e17c1c198aa8150c87473849d61e92692083777` verifier. The base checkout and Node pin, all evidence rules, required checks, protection and permissions remain unchanged; other bases and PR shapes still use their own base verifier. See [One-time historical-base bootstrap](quality-gate-evidence.md#server-side-evidence-verification-issue-548) for the exact trust boundary and failure behavior.

## Versioning And Delivery

The first GitHub Release is `v0.2.0`, matching the application version already shared by the frontend, Rust, and Tauri configuration. It is a source-only release and makes no 1.0 stability promise. Passing frontend and Rust CI does not establish desktop distribution readiness.

For a later release:

1. Update `package.json`, `package-lock.json`, `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock`, `crates/plotweave-core/Cargo.toml`, `crates/plotweave-ffi/Cargo.toml`, `crates/Cargo.lock`, and `src-tauri/tauri.conf.json` to one consistent application version, and add release notes in the same task pull request when a version change is needed. The virtual `crates/Cargo.toml` workspace has no package version. Keep the native app/test Debug and Release `MARKETING_VERSION`, build number, and actual-bundle assertion in `NativeLaunchModeTests` synchronized too.
2. Merge the prepared work into `dev`, then use a `dev` to `main` release pull request.
3. Wait for the `main` push CI to pass.
4. Create the version tag and GitHub Release at the verified `main` merge commit.

Before attaching desktop binaries, separately complete target-platform packaging, signing and notarization where applicable, install/launch verification, and native critical-flow acceptance. State the platform, architecture, checksum, and known limitations in the Release. Never describe an unverified artifact as an installable delivery.

There is currently no long-lived `release` branch. Published version tags identify immutable source snapshots; documentation corrections made after a tag appear in later commits and releases rather than rewriting published history.

## Engineering References

- [Software Engineering Standard](software-engineering-standard.md)
- [TypeScript Standard](typescript-standard.md)
- [Rust Standard](rust-standard.md)
- [Swift Standard](swift-standard.md)
- [Issue Standard](issue-standard.md)
- [File Size Guard](file-size-guard.md)
- [Data Model Index](../data-model/README.md)
- [UI Design Specification](../ui-design.md)
