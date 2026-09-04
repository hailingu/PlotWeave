# Issue Standard

**Applies to**: every issue opened in the `hailingu/PlotWeave` GitHub
tracker, by humans and agents alike. Like the other standards under
`docs/development/`, this file is written in English for agent
interoperability; issue bodies themselves SHOULD follow the project
documentation language (Chinese).

**Last reviewed**: 2026-09-04

## Required Reading

- [AGENTS.md](../../AGENTS.md) — the Review And Response Policy section
  defines the severity calibration this standard aligns with, the
  out-of-scope threat model, and the disposition rules that govern how
  findings and issues are answered and closed.

## Title Format

Every issue title MUST use exactly this shape, mirroring the Conventional
Commits format used for commits in this repository, with the severity tag
replacing the type word:

    P<1|2|3>(<scope>): <summary>

- `P<1|2|3>` — severity, defined below. Severity is carried only by this
  tag and its matching label; urgency words (紧急, 严重, blocker) MUST NOT
  appear in the summary.
- `<scope>` — the same area token used in this repository's commit scopes
  (`editor`, `settings`, `imagegen`, `store`, `library`, `model`,
  `prefs`, `canvas`, …). Use one scope; do not bundle unrelated areas.
- `<summary>` — one line in the issue's natural language, no trailing
  period. It states the problem or boundary, not the fix.

Conventional-Commit type words (`feat`, `fix`, `refactor`, `docs`, …)
MUST NOT appear in issue titles; they classify commits, not problems.
Free-form prefixes without a scope (for example `P3 已知边界：…`) do not
conform either.

Examples:

    P1(store): 锚定句柄校验被绕过导致跨项目资产越权删除
    P2(imagegen): 生成作业取消后产物偶发残留于资产索引
    P3(prefs): llm_chat 响应体缺少大小上限（防御性加固）

## Severity

The AGENTS.md severity calibration governs. Applied to the tracker:

- **P1** — user data loss, corruption, or exposure that is realistically
  reachable through normal use, common dirty data, or known system
  behavior; or a core workflow that is unusable (crash on launch, save
  always failing). Fix before merging any related task.
- **P2** — defects and contract inconsistencies whose trigger requires
  rare dirty data, narrow race windows, or extreme values; broken
  behavior that still has a workaround. Fix or register as a known
  boundary, at the repository owner's discretion.
- **P3** — further defense-in-depth layers, defensive validation, missing
  documentation on public symbols, extreme-value hardening, quality debt,
  and anything overlapping the documented out-of-scope threat model.
  Recorded and scheduled at the owner's discretion; never blocks a merge.

A severity claim MUST be backed by a trigger description or reproduction
steps in the body. When the severity is uncertain, open at the higher
severity and let triage lower it; severity-less issues do not conform.

## Labels

- Exactly one severity label — `P1`, `P2`, or `P3` — MUST be present and
  MUST match the title tag.
- `known-boundary` MUST be added when the issue records a disposition
  rather than an accepted defect (for example a P3 boundary that survived
  a review round under the AGENTS.md round budget).
- Area labels MAY mirror the title scope.

## Body Structure

One issue reports one problem; do not batch unrelated defects into a
single issue. Use the matching structure:

Defect / regression:

    ## 环境 (Environment)
    ## 复现步骤 (Steps to Reproduce)
    ## 期望结果 (Expected)
    ## 实际结果 (Actual)
    ## 证据 (Evidence)
    ## 回归来源 (Regression Source)

Known boundary:

    ## 边界描述 (Boundary)
    ## 触发条件 (Trigger)
    ## 现有防线 (Existing Defense)
    ## 处置 (Disposition)

Feature / improvement:

    ## 背景与目标 (Goal)
    ## 方案草案 (Draft Approach)
    ## 验收标准 (Acceptance Criteria)

Evidence cites stable artifacts — commit identifiers, command output,
logs, screenshots — per the AGENTS.md verification rules; mutable line
numbers are supplementary only. `Regression Source` cites the commit that
introduced the defect when known.

## Closing

An issue closes only with the resolving commit referenced in a comment
or, for known boundaries and resolved-without-change dispositions, with
the rationale and evidence recorded per the AGENTS.md Review And Response
Policy. Bulk-closing without a disposition record is not permitted.
