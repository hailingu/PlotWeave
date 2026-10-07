# Swift Development Standard

**Applies to**: Swift sources under `native/**` — the SwiftUI/AppKit native
shell, its host adapters, and its tests (`native/macos/` today). Like the
root `AGENTS.md`, this file is written in English for agent interoperability.

**Last reviewed**: 2026-10-07

## Required Reading

- [Software Engineering Standard](software-engineering-standard.md) — the
  repository-wide baseline for size, module boundaries, dependency direction,
  abstractions, patterns, testing, and exceptions.
- Swift API Design Guidelines — naming, documentation, and interface design
  for the code's public surface.
- [SwiftUI/AppKit + React Flow migration plan](../swiftui-react-flow-migration-plan.md)
  — §2 fixes architecture and layer ownership; §4 constrains the current
  bridge, lifecycle, and native services. The historical P2 FFI is not linked
  into the Swift application. [Feature Parity](../swiftui-react-flow-feature-parity.md)
  records implemented capabilities, state invariants, and verification gaps. Its
  [current toolchain record](../swiftui-react-flow-toolchain.md) records the
  owner-approved Xcode 27.0 upgrade and its verification; P1 evidence
  retains the historical toolchain used in 2026-09-15 runs.

## Toolchain And Project Layout

- The current toolchain is Xcode 27.0 (`27A266a`), Swift 6.4 compiler
  (`swiftlang-6.4.0.34.1 clang-2100.3.34.1`), and macOS SDK 27.0, per the
  owner decision and measurements in the [current toolchain record](../swiftui-react-flow-toolchain.md).
  Keep Swift 6 language mode (`SWIFT_VERSION = 6.0`) and the macOS 26.0
  deployment target; compiler/SDK versions do not redefine either setting.
  The recovered worktree evidence used macOS 26.6.2; current local checks
  record their actual runtime separately. Native CI uses `xcode-27` on
  macOS 27.0. CI explicitly selects
  `/Applications/Xcode_27.0.app/Contents/Developer` through `DEVELOPER_DIR`
  and checks Xcode 27.0 plus SDK 27.0 before building.
  Build and test through the
  `native/**` Scope Routing `xcodebuild` command from the repository root;
  do not invent alternative invocations or build roots.
- The Xcode project is hand-maintained: target membership comes from
  folder-synchronized groups (`App/` → app target, `Tests/` → test target)
  and the shared scheme under `xcshareddata/xcschemes/` is committed. Do not
  regenerate the project or convert it to per-file membership entries.
- `native/macos/build/` is disposable verification output and is deleted
  before task completion. Never commit `xcuserdata/`, user schemes, or
  `*.xcuserstate`.
- No third-party package dependency (SPM, CocoaPods, or otherwise) without
  explicit task scope.

## Swift Engineering Practices

- Swift 6 language mode. Data-race safety diagnostics (Sendable conformance,
  actor isolation) are defects to fix by design, never to silence with
  `nonisolated(unsafe)` or `@unchecked Sendable` without a documented
  reason in the adopting change.
- All UI code runs on the main actor. Background work uses structured
  concurrency owned by an explicit lifecycle object that cancels on release;
  no fire-and-forget `Task` without a documented owner (migration plan §4.3).
- AppKit system readers in nested value types carry explicit `@MainActor`
  isolation on their entry point and helper chain; the containing class's
  isolation does not supply that contract. Keep pure snapshot construction,
  comparison and serialization separate from system reads. Verification is
  recorded in the [appearance isolation matrix](../swiftui-react-flow-p1-evidence.md#关键状态与不变量矩阵).
- No force unwrapping (`!`), `try!`, `as!`, or `fatalError` in production
  paths. Fallible behavior returns typed errors, and failures surface as
  visible diagnostics rather than silent fallbacks (migration plan §4.1).
- Document types, protocols, functions, and properties with intent-bearing
  doc comments before their implementation bodies, including target-internal
  declarations (root `AGENTS.md`).
- The root `AGENTS.md` file caps apply to `native/**`: 800 physical lines
  for source and 1800 for Swift tests under `Tests/`. The executable-unit
  standard is 80 code lines, excluding comments but counting blank lines,
  and is review-enforced under the same owner decision as other languages.
  `npm run check:size` measures Swift files and classifies native project files.
- Use public SwiftUI/AppKit/WebKit API only. No private API, no KVC
  background tricks, and no whole-window-transparency assumptions
  (migration plan §2.2).
- Verification builds must not read or write the user's real
  application-data directory. Tests inject temporary roots; production uses
  Application Support under `BundleID + ".development"`, currently
  `dev.plotweave.PlotWeaveNative.development`, opened on the first service
  request. It does not read Tauri's data root or historical Keychain.
  A release identity and signed distribution remain separate decisions.
- Native storage, asset, preferences and model services are implemented in Swift
  (owner decision, 2026-10-04). Follow migration plan §4.3: injected data roots,
  serialized writes, bounded media, explicit task ownership and cancellation,
  compatible encrypted settings and observable errors. The new app does not
  link Rust/Tauri; their existing code remains a regression reference.
- SwiftUI owns the business interface; React owns the single editing session,
  graph commands, history, and canvas. Native forms submit editing intents and
  consume read-only projections, never independently writable document copies.
  The default Web entry is the production application; `#fixture` selects the
  isolated memory demo. Swift implements 25 business and two quit commands
  using the existing snake_case IPC names, plus `system.copyText` and
  `system.saveText` for native text delivery.

## Testing

- Swift Testing (`import Testing`) is the unit-test framework; tests live in
  each project's `Tests/` folder. UI tests get a dedicated UI-test target
  when that slice lands.
- Red-Green-Refactor per the root `AGENTS.md`: add the smallest focused
  failing test for the missing behavior, observe it fail, then implement.
  Tests assert observable behavior and contracts, never prose or layout
  trivia.
- App-hosted tests must not touch user data or public model endpoints. Use
  isolated temporary roots, synthetic secrets, injected transports/resolvers,
  and URLProtocol fixtures. Real WKWebView tests exercise local resources.
  Green unit and integration tests do not establish public TLS trust-chain,
  paid-provider, visual, IME, VoiceOver, or performance acceptance; retain
  those gaps in [Feature Parity](../swiftui-react-flow-feature-parity.md).

## Before Writing Code

Read this file, then inspect the existing native sources for stage records,
host adapters, and test fixtures to reuse. Keep the layering of migration
plan §2.1: SwiftUI views and AppKit adapters do not own editing-document
state; they communicate through the seams the plan defines, and new behavior
lands behind the smallest coherent target boundary.
