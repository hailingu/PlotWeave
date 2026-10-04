# Development Workflow

This document is the developer entry point for PlotWeave. It keeps repository structure, toolchain, branch policy, continuous integration, local gates, and delivery rules separate from the user-facing product README. Detailed gate behavior and engineering standards remain authoritative in the linked documents.

## Technology And Repository Layout

PlotWeave is a Tauri desktop application. React, TypeScript, and `@xyflow/react` own canvas interaction and document editing; Rust owns Tauri commands, persistence, preferences, media access, and native integration. The `codex/swiftui-react-flow` branch also contains a SwiftUI/AppKit shell with a WKWebView canvas, host-agnostic Rust kernels, and a C ABI; the Swift storage transport is not yet connected.

```text
PlotWeave/
├── .github/        # Pull-request and branch CI
├── .githooks/      # Versioned commit and push gates
├── scripts/        # Static, coverage, SonarQube, and guard scripts
├── src/            # React canvas and frontend application
├── src-tauri/      # Tauri adapters and domains awaiting extraction
├── crates/         # Host-agnostic Rust core and Swift-facing C ABI
├── native/         # SwiftUI/AppKit shell and WKWebView fixture
├── docs/           # Product design and engineering documentation
├── AGENTS.md       # Repository-wide contribution policy
└── README.md       # User-facing product introduction
```

Discover exact dependency versions and commands from `package.json`, `package-lock.json`, `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock`, `crates/Cargo.toml`, `crates/Cargo.lock`, `src-tauri/tauri.conf.json`, `.nvmrc`, and `rust-toolchain.toml`. Those versioned files take precedence over prose summaries.

## Local Setup

### 支持平台

当前支持平台为 **macOS**；**不支持 Windows**，应用运行、开发工具链、提交/推送门禁及发行均不承诺 Windows 兼容性。仓库构建与 CI 只在 macOS 上验证，Linux 也没有本仓库的构建与测试覆盖；使用 Unix 进程组不代表支持所有 Unix 平台。

按所有者在 [issue #503](https://github.com/hailingu/PlotWeave/issues/503) 的处置决定，Windows 慢路径推送会被安装监督器拒绝。快路径即使未触发该拒绝，也不属于受支持的 Windows 工作流；贡献者须在 macOS 上执行完整门禁并推送。具体后果与依赖 lifecycle 的进程约束见[平台支持范围与依赖进程契约](quality-gate-push.md#平台支持范围与依赖进程契约issue-503)。

### 开发环境

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

### 原生画布演示与验证

原生工程当前仅提供内存画布演示，Rust 项目存储内核/FFI 已抽出，但未链接真实 Swift 传输，不等同完整业务应用。阶段与工具链见[改造计划](../swiftui-react-flow-migration-plan.md)、[P1 证据](../swiftui-react-flow-p1-evidence.md)和[P2 证据](../swiftui-react-flow-p2-evidence.md)。

```bash
nvm use
npm run build:native
open -n native/macos/build/DerivedData/Build/Products/Debug/PlotWeaveNative.app
```

`build:native` 依次构建画布资源与原生应用。`open -n` 启动本次构建的新实例；重新构建后已运行的窗口不会自动替换资源。单独 `xcodebuild build` 不会重建画布资源，缺失时应用显示诊断；Xcode ⌘R 调试前先运行 `npm run build:native-canvas`。资源使用 IIFE 经典脚本与独立 CSS 适配 WKWebView 的 `file://` 加载，独立入口包含 React Flow 基础样式。

原生路由验证在仓库根目录执行 `npm run check:size && npm run build:native-canvas && xcodebuild -project native/macos/PlotWeaveNative.xcodeproj -scheme PlotWeaveNative -destination 'platform=macOS' -derivedDataPath native/macos/build/DerivedData test`。真实页面须检查 ready 握手、节点渲染与有效定位样式；不能只检查资源入包。`native/macos/build/` 与 `native/macos/App/WebCanvas/` 均为忽略的生成产物；纯验证输出在任务完成前删除，本地演示构建使用完后删除。

## Branch And Pull-Request Model

`dev` is the development integration baseline. `main` is the enabled release branch.

- Create task branches from the current authorized `dev` checkout, using an appropriate `feature/`, `fix/`, `docs/`, or `chore/` prefix.
- Target ordinary task pull requests at `dev`.
- Only a repository integration or release pull request from `dev` may target `main`.
- Do not commit or push directly to `dev` or `main`.
- Require passing pull-request CI before integration. After merging `dev` into `main`, require the `main` push CI to pass before creating the version tag and GitHub Release at that exact merge commit.

These are repository collaboration rules. They do not assert that GitHub branch protection or rulesets are configured. Changing remote permissions or protection settings requires a separate owner decision.

## Pull-Request Continuous Integration (Issue #228)

`.github/workflows/ci.yml` runs for pull requests and pushes involving `dev` or `main` on the repository's configured macOS runner. Its frontend job checks Prettier formatting, ESLint with zero warnings, strict TypeScript, maintained-file size, the production build, frontend tests, and script/hook behavior tests. Its Rust job checks formatting, Clippy with warnings denied, and Rust tests in both `src-tauri/` and `crates/`, then runs the Rust module-graph guard meta-check. The frontend and Rust jobs use `macos-15`; the native job uses `macos-26`, verifies that the default Xcode is the P1-pinned `26.6`, then runs `npm run build:native-canvas` and the routed `xcodebuild test` command. The [official macOS 26 runner image inventory](https://github.com/actions/runner-images/blob/main/images/macos/macos-26-arm64-Readme.md) lists Xcode 26.6 as its default when checked on 2026-10-04. These configured jobs require their own passing CI runs; local results do not establish hosted CI status.

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
