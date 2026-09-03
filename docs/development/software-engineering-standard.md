# Software Engineering Standard

**Applies to**: all maintained production and test source code in this
repository. Read this file together with every matching language standard.
Like the root `AGENTS.md`, this file is written in English for agent
interoperability.

**Last reviewed**: 2026-09-03

## Purpose And Precedence

This standard governs software structure and maintainability across languages.
Language standards define how these rules map to native packages, modules,
types, components, interfaces, and tools. A language standard may narrow this
baseline but must not weaken or contradict it.

Accepted decisions, public contracts, security and accessibility requirements,
the applicable design references, and platform constraints take precedence
when they bind a design. Record and resolve a conflict instead of silently
choosing one rule over another.

## Size And Complexity Guardrails

Size is a review signal, not a substitute for judging cohesion. Crossing a
review threshold requires an explicit decomposition review. The repository's
hard caps in the root [`AGENTS.md`](../../AGENTS.md) (800 physical lines for
maintained source files, 1800 for test files, 80 for executable units) remain
mandatory; the review thresholds below trigger earlier, discussion-only
attention.

| Unit | Decomposition-review threshold | Hard limit (per AGENTS.md) |
| --- | --- | --- |
| Maintained production source file | More than 600 physical lines | 800 physical lines |
| Maintained test source file | More than 1,000 physical lines | 1,800 physical lines |
| Function, method, closure, hook, component, or equivalent executable unit | More than 60 physical lines | 80 physical lines |
| Cyclomatic complexity, when measured by configured tooling | More than 10 | N/A — record and decompose |
| Executable nesting depth | More than 4 levels | 6 levels |

Apply the guardrails as follows:

- Count a file's complete physical span, including comments and documentation,
  because that is the amount a reviewer must navigate. Count an executable
  unit's span from its declaration or signature through the end of its
  implementation body; preceding annotations and documentation comments are
  outside the limit.
- Treat every measurement as point-in-time evidence for the inspected source
  revision. Re-run the review when an affected change crosses a threshold; do
  not continuously rewrite historical evidence after unrelated edits.
- Generated, vendored, lock, machine-produced schema, snapshot, fixture-data,
  and immutable migration-history files are excluded from the numeric limits.
  Their source or generating workflow remains subject to review.
- When no configured tool measures cyclomatic complexity, record
  `N/A — no configured complexity tool` and use executable-unit line span plus
  nesting depth as the required substitute signals. Tool absence never means
  that the complexity threshold passed.
- Declarative registries, protocol declarations, UI composition, and exhaustive
  test tables are not automatically exempt. They may remain large when the
  decomposition review demonstrates one cohesive responsibility.
- Crossing a review threshold does not require a mechanical split. Record why
  the unit is cohesive and why extraction would worsen coupling, readability,
  ordering, or lifecycle safety.
- Do not satisfy a limit by moving unrelated code into a generic helper,
  creating pass-through wrappers, or splitting one operation into files that
  must always be read and changed together.

## Responsibility And Module Boundaries

- A module, package, feature, or component must own one coherent capability and
  have one primary reason to change. Name it after that responsibility rather
  than an incidental implementation detail.
- Organize services and applications by feature or domain at their main
  boundary. Use technical layers inside a feature when separating them creates
  a meaningful dependency, failure, ownership, or test boundary.
- Separate transport or UI delivery, application orchestration, domain policy,
  persistence, and external-provider integration when they vary, fail, scale,
  or are tested independently. Small programs may keep them together while
  those forces do not exist.
- Keep the public surface minimal and intentional. Internal implementation
  details must not become public merely to make tests or imports convenient.
- A new module must have a clear owner, inputs, outputs, invariants, and error
  behavior. Public modules and declarations require intent-bearing
  documentation before their implementation bodies.
- Generic `utils`, `helpers`, `common`, `shared`, or `misc` dumping grounds are
  prohibited. Shared code needs a specific capability name and must satisfy the
  extraction criteria in
  [Abstractions And Design Patterns](#abstractions-and-design-patterns).
- Prefer colocating code that changes together. Split code when responsibilities
  or change lifecycles differ, not merely because a directory looks large.

## Dependency Design

- Dependencies point from delivery and infrastructure adapters toward stable
  application or domain contracts. Core business rules must not depend on Web,
  UI, database, provider, serialization, or framework details.
- Cyclic dependencies between maintained modules or packages are prohibited.
  Resolve a cycle by clarifying ownership, extracting a stable contract, or
  moving shared policy to the module that owns it.
- Cross-module calls must use the owning module's public API. Do not import its
  internal persistence models, framework objects, mutable state, or private
  helpers.
- Translate external request, response, database, and provider types at the
  boundary. Do not let them become the repository-wide domain model by
  convenience.
- Keep dependency direction visible in names and layout. A boundary that exists
  only by convention but is routinely bypassed is not an effective boundary.

## Abstractions And Design Patterns

- Start with the simplest direct design that preserves the required boundary.
  Introduce an abstraction only for demonstrated variation, independent
  lifecycle, external I/O, reusable policy, or a necessary test seam.
- Interfaces, protocols, and traits belong at the boundary that consumes the
  behavior. Do not create one interface per concrete type or a factory for a
  single direct construction path without an identified variation.
- Before applying a named design pattern, identify the recurring problem, the
  forces it resolves, the expected variation, and the simpler alternative that
  was considered. The pattern is an implementation tool, not a target
  architecture.
- Prefer composition and explicit delegation over inheritance. Inheritance is
  appropriate only for a genuine substitutable relationship with preserved
  invariants, not for code reuse alone.
- Use dependency injection explicitly through constructors, parameters, or
  language-native environment mechanisms. Service locators and mutable global
  singletons are prohibited unless an approved exception defines their bounded
  lifetime and removal plan.
- Do not generalize code after a single example. Extract shared behavior when
  at least two real consumers have the same semantics and expected evolution.
  A consumer-owned external boundary may be defined before a second
  implementation exists when it prevents external types or semantics from
  leaking into the core. Similar syntax with different business meaning must
  remain separate.

### Pattern Selection Guide

Use this table to start a design discussion. A named pattern is justified by
the stated problem and forces, not by matching a class diagram mechanically.

| Pattern or approach | Appropriate problem | Do not use it merely to |
| --- | --- | --- |
| Adapter / anti-corruption layer | Translate an external API, framework, provider, storage, or legacy model into an owned contract. | Rename fields while still leaking external semantics throughout the core. |
| Strategy | Select between behaviorally meaningful algorithms or providers behind one stable consumer-owned contract. | Hide one implementation or replace a simple conditional whose variants do not evolve independently. |
| Explicit state machine | Model a finite lifecycle with guarded transitions, invalid states, retries, cancellation, or terminal outcomes. | Distribute state checks across handlers without one transition owner. |
| Repository | Give domain logic collection-like access to persisted aggregates while hiding storage mechanics. | Wrap every CRUD table or forward ORM calls without domain semantics. |
| Domain/application service | Own policy or orchestration that does not naturally belong to one value or entity. | Create broad `Service` or `Manager` classes containing unrelated use cases. |
| Event / observer | Notify multiple independent consumers or cross an asynchronous ownership boundary with defined delivery semantics. | Replace a direct call when ordering, failure, duplication, and ownership are unspecified. |
| Middleware / decorator | Apply ordered cross-cutting boundary behavior such as authentication, tracing, retries, or rate limits. | Hide core business rules or create an execution order that reviewers cannot trace. |
| Factory / builder | Centralize construction that varies by type, enforces multiple invariants, or has a staged configuration. | Avoid a clear constructor or create indirection for a single fixed type. |
| Facade | Present a small stable API over a complex subsystem owned behind that boundary. | Create a pass-through layer that adds no ownership, translation, policy, or compatibility value. |
| Vertical slice | Keep one use case's delivery, application logic, and tests together while respecting inward dependencies. | Duplicate shared domain policy or bypass another feature's public API. |
| Ports and adapters | Isolate a substantial core from multiple volatile delivery, persistence, or provider technologies. | Add layers to a small script or simple CRUD feature with no independent domain behavior. |

## State, Concurrency, And Failure Boundaries

- Give every mutable state value one clear owner. State transitions must be
  explicit, validated, and observable at the boundary where failure matters.
- Make side effects visible in APIs and keep them at controlled boundaries.
  Domain calculations should be deterministic where practical.
- Define cancellation, timeout, retry, idempotency, and partial-success behavior
  before adding concurrent or distributed execution. A retry must not duplicate
  a non-idempotent effect.
- Handle errors at the layer that can add context or choose recovery. Preserve
  the original cause and use the project's structured diagnostics; do not log
  and rethrow the same failure at every layer.
- Follow the trust-boundary validation requirements in the Security section of
  the root [`AGENTS.md`](../../AGENTS.md). After validation, maintain valid
  internal types and invariants rather than propagating uncertain external
  state through the core.

## Testing And Change Design

- Develop source-code features and reproducible defect fixes with
  Red-Green-Refactor as required by the root [`AGENTS.md`](../../AGENTS.md):
  first add the smallest focused test for the missing behavior, observe the
  expected failure, then implement and keep focused and routed suites green.
  Documentation-only changes do not manufacture a failing source test; they
  undergo a structured review instead.
- Test observable behavior and stable contracts. Avoid tests coupled to private
  call order, framework internals, or incidental data structures unless that
  detail is itself the contract.
- Do not inspect repository-versioned source or documentation as opaque text to
  assert ordinary prose, exact phrasing, substring presence or occurrence
  counts, physical line counts, formatting, section placement, or
  implementation layout; see the root `AGENTS.md` for the authoritative wording
  of this rule.
- When an applicable risk belongs to a production framework, datastore,
  provider transport, or other external adapter, at least one linked check must
  exercise that production boundary or a behaviorally equivalent integration
  harness. A unit double that bypasses framework rejection, transaction or lock
  behavior, protocol framing, cancellation, timeout, or resource ownership
  cannot by itself establish that boundary as verified.
- Keep unit tests near their owning module according to language convention.
  Put integration and contract tests at the boundary they exercise.
- A bug fix should add the smallest regression test that fails for the reported
  behavior and passes for the corrected behavior when reproduction is feasible.
- A module split is complete only when its tests, ownership, public API, and
  dependency direction reflect the new boundary; moving lines alone is not a
  structural improvement.
- Reuse an existing component, client, schema, error type, test fixture, or
  helper when it has the same ownership and semantics. Do not create a parallel
  abstraction solely to avoid understanding the existing one.

## Incremental Adoption And Exceptions

New code must comply immediately. Existing code is assessed when it is
materially changed. Do not expand an unrelated task solely to remediate an old
threshold unless the approved scope includes that refactor; record the observed
debt, its affected path or symbol, and the reason it remains out of scope in
the pull request that touched the unit.

The hard limits in the root `AGENTS.md` (800/1800/80, with grandfathering at
the recorded count) cannot be waived here. For any other guardrail in this
standard, an engineering exception must be recorded in the pull request that
introduces or retains the exceptional unit, with: the exact rule and affected
path or symbol; the measured value or structural condition; why the unit
remains cohesive or why compliance is unsafe now; the risks of retaining it;
compensating controls such as focused tests; one accountable owner; and a
removal or review date, or a specific reason the exception is permanent.
Revisit the exception whenever the affected unit is materially changed.

## Before Writing Code

Read this file and every matching language or platform standard in full. Then
inspect the affected module and answer these questions before implementation:

- Which module owns the behavior and its invariants?
- Which responsibilities change together, and which vary independently?
- What is the permitted dependency direction?
- Is an existing internal capability semantically suitable?
- Does the design cross a review threshold or require an exception?
- What observable contract and failure behavior will the tests verify?
