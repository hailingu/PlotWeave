# Development Workflow

This document is the developer entry point for PlotWeave. It keeps repository structure, toolchain, branch policy, continuous integration, local gates, and delivery rules separate from the user-facing product README. Detailed gate behavior and engineering standards remain authoritative in the linked documents.

## Technology And Repository Layout

PlotWeave retains its Tauri/React Flow/Rust application as the released baseline. On `dev`, SwiftUI owns the business interface, AppKit owns window and system integration, and Swift services own project storage, library assets, preferences, encrypted keys, and model requests. React, TypeScript, and `@xyflow/react` retain the single editing session, graph commands, undo/redo, and canvas inside WKWebView. The native application uses the existing typed IPC contracts without linking Rust or the historical C ABI; current capability and verification boundaries are recorded in [Feature Parity](../swiftui-react-flow-feature-parity.md). The native application was developed on the historical branch `codex/swiftui-react-flow`, whose content merged into `dev` through [PR #526](https://github.com/hailingu/PlotWeave/pull/526) on 2026-10-13; that branch no longer exists on the remote.

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

### 支持平台

当前支持平台为 **macOS**；**不支持 Windows**，应用运行、开发工具链、提交/推送门禁及发行均不承诺 Windows 兼容性。仓库构建与 CI 只在 macOS 上验证，Linux 也没有本仓库的构建与测试覆盖；使用 Unix 进程组不代表支持所有 Unix 平台。

按所有者在 [issue #503](https://github.com/hailingu/PlotWeave/issues/503) 的处置决定，Windows 慢路径推送会被安装监督器拒绝。快路径即使未触发该拒绝，也不属于受支持的 Windows 工作流；贡献者须在 macOS 上执行完整门禁并推送。具体后果与依赖 lifecycle 的进程约束见[平台支持范围与依赖进程契约](quality-gate-push.md#平台支持范围与依赖进程契约issue-503)。

### Tauri 基线开发环境

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
- Maintained source size: `npm run check:size` (includes extracted Rust crates and native Swift sources).
- Rust checks from either `src-tauri/` or `crates/`: `npm --prefix .. run check:size && cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test`
- Complete local quality gate: `npm run sonar:gate`

### 原生应用启动与验证

2026-10-07 将归档工作树的完整源码恢复并合入当前主目录，构建入口不再指向早期演示壳；来源、重叠修改协调与本次检查见[合入记录](../swiftui-react-flow-integration.md)。

当前 `dev` 分支的原生应用已实现 SwiftUI 项目首页、工具栏、大纲、属性检查器、设定、图库、AI、导出与应用设置界面，以及 Swift 存储、素材、设置／密钥和模型服务。Swift 承接 25 条业务命令与两条退出命令，共 27 条既有 snake_case IPC 命令，另提供 `system.copyText` 与 `system.saveText` 两条系统交付命令。React 保留单一编辑会话、历史与画布；默认资源入口运行生产应用，只有显式 `#fixture` 加载不落盘的内存演示。当前行为及测试矩阵见[功能补齐记录](../swiftui-react-flow-feature-parity.md)，原 P1／P2 状态仅作为[历史证据](../swiftui-react-flow-p1-evidence.md)与[历史 Rust 抽离记录](../swiftui-react-flow-p2-evidence.md)保留。

需要 macOS 26.0+、Node 24.18.0 与 Xcode 27.0／macOS SDK 27.0，不需要 Rust 来构建原生应用。Swift 6.4 编译器维持 Swift 6 语言模式；所有者升级决策、实测版本与构建／启动结果见[当前工具链记录](../swiftui-react-flow-toolchain.md)。依赖未安装时先运行 `npm install`，并按上节安装版本化 Git hooks。

当前构建工具链固定为 Xcode 27.0、macOS SDK 27.0，工程语言模式仍为 Swift 6，最低部署版本仍为 macOS 26.0。构建前用 `xcodebuild -version` 与 `xcrun --sdk macosx --show-sdk-version` 确认所选工具链；实际系统版本、编译器与验证边界见 [Xcode 27 工具链记录](../swiftui-react-flow-p1-evidence.md#xcode-27-工具链同步2026-10-07)。

```bash
nvm use
npm run build:native
open -n native/macos/build/DerivedData/Build/Products/Debug/PlotWeaveNative.app
```

`build:native` 依次构建画布资源与原生应用。`open -n` 启动本次构建的新实例；重新构建后已运行的窗口不会自动替换资源。单独 `xcodebuild build` 不会重建画布资源，缺失时应用显示诊断；Xcode ⌘R 调试前先运行 `npm run build:native-canvas`。资源使用 IIFE 经典脚本与独立 CSS 适配 WKWebView 的 `file://` 加载，独立入口包含 React Flow 基础样式。

排查拖动渲染耗时时可运行 `PLOTWEAVE_CANVAS_PROFILE=1 npm run build:native`，随后退出旧实例、启动新构建并开启画布左下角性能诊断。该显式模式使用 React 生产 profiling renderer，报告区分编辑器整体与画布子树；普通构建保留默认禁用 Profiler 的行为。指标边界、复测方式与测试证据见[画布性能诊断](canvas-performance-diagnostics.md)。

本地原生数据根使用 Application Support 下的 `BundleID + ".development"`，当前为 `dev.plotweave.PlotWeaveNative.development`；首次真实请求才打开目录。它不读取旧 Tauri 数据根或历史 Keychain。测试注入临时根、合成密钥与传输，不使用该真实开发目录；请勿同时启动多个实例写同一根，本次实现仍以单用户单实例为边界。

原生路由验证在仓库根目录执行 `npm run check:size && sh scripts/test-native.sh`。共享 TestAction 在启动前选内存宿主；真实窗口、焦点与退出委托共享 `NSApplication`，功能回归串行执行以隔离夹具，见 [PR #526 修复记录](../swiftui-react-flow-pr526-fixes.md)。所有者在 PR #604（2026-10-18）选择日常保留功能回归、压力测试按需运行：`sh scripts/test-native.sh stress` 单独运行持续性能、长循环内存与首拖测量，原规模和断言保留，选择边界见 [Native Regression And Stress](quality-gate-push.md#native-regression-and-stress)。回归覆盖真实 WKWebView 生产页面／夹具、会话桥、存储、媒体、设置、模型传输与退出；不能只检查资源入包。真实公网 TLS 信任链、模型计费、实际系统面板、视觉、中文输入法、VoiceOver 与触控板性能仍未验收，详见[功能补齐记录](../swiftui-react-flow-feature-parity.md)。`native/macos/build/` 与 `native/macos/App/WebCanvas/` 均为忽略的生成产物；纯验证输出在任务完成前删除，本地运行构建使用完后删除。

## Branch And Pull-Request Model

`dev` is the development integration baseline. `main` is the enabled release branch.

- Create task branches from the current authorized `dev` checkout, using an appropriate `feature/`, `fix/`, `docs/`, or `chore/` prefix.
- Target ordinary task pull requests at `dev`.
- Only a repository integration or release pull request from `dev` may target `main`.
- Do not commit or push directly to `dev` or `main`.
- Require passing pull-request CI before integration. After merging `dev` into `main`, require the `main` push CI to pass before creating the version tag and GitHub Release at that exact merge commit.

These repository collaboration rules are backed by GitHub branch protection, which is enabled for both `dev` and `main` (owner decision, [issue #548](https://github.com/hailingu/PlotWeave/issues/548), 2026-10-16): a pull request is required, the four `ci` jobs — `frontend`, `rust`, `native`, and `gate-evidence` — are required status checks, administrators are included in enforcement, and force pushes and branch deletions are blocked. The authoritative policy statement is [AGENTS.md](../../AGENTS.md); changing remote permissions or protection settings still requires a separate owner decision.

## Pull-Request Continuous Integration (Issue #228)

`.github/workflows/ci.yml` runs for pull requests and pushes involving `dev` or `main` on the repository's configured macOS runner. Its frontend job checks Prettier formatting, ESLint with zero warnings, strict TypeScript, maintained-file size, the production build, and frontend tests; the script/hook behavior tests run inside that same default suite, because Vitest's default discovery already includes `scripts/**/*.test.ts`, so the former duplicate `npm test -- scripts` step was removed (issue #617). It also runs `npm audit --audit-level=high` as a warning-only step (issue #552: `continue-on-error` first to avoid false-positive breakage, intended to become blocking once stable). Its Rust job checks the shared-kernel dependency drift guard (`npm run check:workspace-drift`, issue #549: `plotweave-core`'s resolved dependency closure must agree between the two Cargo workspaces), then formatting, Clippy with warnings denied, and Rust tests in both `src-tauri/` and `crates/`. Before its `src-tauri` `cargo test` it installs frontend dependencies and builds the frontend bundle (`npm ci` + `npm run build`, issue #551): the `frontend_bundle_chain` integration test drives the real `dist/` build through a real Wry webview over IPC into real persistence, and it self-skips with a notice when `dist/` is absent — locally that keeps the routed Rust checks runnable without a prior frontend build, while in CI the build steps guarantee the case always runs. It also audits both workspace lockfiles with `cargo audit` (issue #552, installed via `taiki-e/install-action`): vulnerability advisories fail the job, while informational warnings (unmaintained, unsound, yanked) do not. The frontend and Rust jobs use `macos-15`; the native job uses `xcode-27`, sets `DEVELOPER_DIR` to `/Applications/Xcode_27.0.app/Contents/Developer`, and verifies Xcode `27.0` and macOS SDK `27.0` before running `sh scripts/test-native.sh` (canvas build and serial functional regression; stress measurements are opt-in). The [official Xcode 27 image inventory](https://github.com/actions/runner-images/blob/main/images/macos/xcode-27-arm64-Readme.md) lists that version alias and SDK when checked on 2026-10-07; the [runner announcement](https://github.com/actions/runner-images/issues/14404) identifies the image as a public preview. Since issue #548, a fourth job `gate-evidence` runs on `ubuntu-latest` for pull requests only: `scripts/verify-gate-evidence.ts` checks every commit in the PR range except the tip against the versioned gate ledger at the PR head, so a PR whose commits were created without the local gate fails CI (the tip's own record lags one commit and only warns; semantics in [Gate Run Evidence](quality-gate-evidence.md#server-side-evidence-verification-issue-548)). These configured jobs require their own passing CI runs; local results do not establish hosted CI status.

Hosted CI does not run the local SonarQube scan because that service is not reachable from the hosted runner. Local coverage and SonarQube requirements remain mandatory and are not weakened by green CI; the hosted `gate-evidence` job verifies the ledger evidence those local runs leave behind, and GitHub branch protection on `dev`/`main` (issue #548; see [Branch And Pull-Request Model](#branch-and-pull-request-model) above) requires a pull request plus these four passing checks, rejecting direct pushes such as `git push --no-verify`. See [AGENTS.md](../../AGENTS.md) for scope routing and [Quality Gate Cost Decision](quality-gate-cost.md) for the accepted gate design.

## Dependency And Supply-Chain Visibility (Issue #552)

Dependabot (`.github/dependabot.yml`) opens weekly pull requests for the npm root manifest, the two Cargo workspaces (`src-tauri/` and `crates/`), and GitHub Actions, all targeting `dev`. Minor and patch updates are grouped per ecosystem to reduce noise; major updates stay separate for individual review, because the deliberate major-version lag of react, vitest, typescript and friends is a generational decision that needs review rather than batch-following. The pinned toolchains (`.nvmrc`, `rust-toolchain.toml`) belong to none of these ecosystems and are untouched. The native application has no third-party Swift package dependencies, so this ecosystem set covers the repository's dependency surface. Dependabot never merges: its pull requests run the same required ci.yml checks as any other pull request, and the `rust` job's `cargo audit` blocks a dependency PR that would introduce a vulnerable crate version.

Known boundary (PR #582 review, P2): `target-branch: dev` binds only the version updates configured in `dependabot.yml`. Dependabot security updates are a separate repository-settings feature — currently **disabled** on this repository — whose pull requests always target the default branch (`main`) by platform behavior that no configuration redirects ([GitHub docs](https://docs.github.com/en/code-security/tutorials/secure-your-dependencies/customizing-dependabot-prs#targeting-pull-requests-against-a-non-default-branch)). If the owner ever enables that feature, a security-update pull request against `main` must not be merged as-is, because it bypasses the branch policy that only `dev`-to-`main` release pull requests may target `main`: close it and re-apply the fix on a task branch targeting `dev`, or record an explicit owner decision accepting the exception. The CI audit steps remain the pre-merge vulnerability gate on the `dev` path in either case.

A Dependabot pull request interacts with the `gate-evidence` required check as follows. Dependabot's default branch shape is a single force-pushed commit, so the PR range contains only the tip and the check passes through the tip-lag tolerance with a warning annotation (`[GATE_EVIDENCE_TIP_LAG]`). If a Dependabot branch accumulates non-tip commits without local gate records (for example after manual collaboration on the branch), `gate-evidence` fails by design; the maintainer then runs the local gate and pushes an evidence commit as documented in [Gate Run Evidence](quality-gate-evidence.md) before merging. No exemption from the evidence check is granted to bot actors.

Audit-step status against the lockfiles as of 2026-10-16: `npm audit --audit-level=high` reports zero findings, and both Cargo workspaces are vulnerability-free. `src-tauri/Cargo.lock` carries eight informational warnings, recorded here as their disposition rather than dedicated lockfile churn: unmaintained `proc-macro-error` (RUSTSEC-2024-0370) and the `unic-*` family (RUSTSEC-2025-0075/0080/0081/0098/0100), unsound `glib` (RUSTSEC-2024-0429), and yanked `chacha20` 0.10.1. These advisory classes do not fail `cargo audit`; they ride along with future dependency updates, and new ones surface in CI output without blocking.

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
- [门禁测试负载与夹具成本（issue #498）](test-workload.md)

## Versioning And Delivery

The first GitHub Release is `v0.2.0`, matching the application version already shared by the frontend, Rust, and Tauri configuration. It is a source-only release and makes no 1.0 stability promise. Passing frontend and Rust CI does not establish desktop distribution readiness.

For a later release:

1. Update `package.json`, `package-lock.json`, `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock`, `crates/Cargo.toml`, `crates/Cargo.lock`, and `src-tauri/tauri.conf.json` to one consistent application version, and add release notes in the same task pull request when a version change is needed.
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
