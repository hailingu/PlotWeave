# Swift Development Standard

**Applies to**: Swift sources under `native/**` — the SwiftUI/AppKit native
shell, its host adapters, and its tests (`native/macos/` today). Like the
root `AGENTS.md`, this file is written in English for agent interoperability.

**Last reviewed**: 2026-10-04

## Required Reading

- [Software Engineering Standard](software-engineering-standard.md) — the
  repository-wide baseline for size, module boundaries, dependency direction,
  abstractions, patterns, testing, and exceptions.
- Swift API Design Guidelines — naming, documentation, and interface design
  for the code's public surface.
- [SwiftUI/AppKit + React Flow migration plan](../swiftui-react-flow-migration-plan.md)
  — §2 fixes the target architecture and layer ownership; §4 constrains the
  future bridge, lifecycle, and FFI behavior. Its
  [P1 evidence record](../swiftui-react-flow-p1-evidence.md) pins the
  toolchain.

## Toolchain And Project Layout

- The toolchain is fixed by the P1 toolchain record (macOS 26 SDK via
  Xcode 26.6, Swift 6 language mode). Build and test through the
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
  application-data directory; data roots are injected by the host, and the
  formal app identity remains a P4 decision (migration plan §4.3).
- Future Rust FFI code follows the C ABI constraints in migration plan §4.3:
  panic containment, explicit buffer ownership, observable cancellation, and
  testable error conversion.

## Testing

- Swift Testing (`import Testing`) is the unit-test framework; tests live in
  each project's `Tests/` folder. UI tests get a dedicated UI-test target
  when that slice lands.
- Red-Green-Refactor per the root `AGENTS.md`: add the smallest focused
  failing test for the missing behavior, observe it fail, then implement.
  Tests assert observable behavior and contracts, never prose or layout
  trivia.
- App-hosted tests must not touch user data or the network; fixtures and
  fake hosts are in-memory and deterministic.

## Before Writing Code

Read this file, then inspect the existing native sources for stage records,
host adapters, and test fixtures to reuse. Keep the layering of migration
plan §2.1: SwiftUI views and AppKit adapters do not own editing-document
state; they communicate through the seams the plan defines, and new behavior
lands behind the smallest coherent target boundary.
