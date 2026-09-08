# Issue Standard

**Applies to**: every issue opened in the `hailingu/PlotWeave` GitHub
tracker, by humans and agents alike. Like the other standards under
`docs/development/`, this file is written in English for agent
interoperability; issue bodies themselves SHOULD follow the project
documentation language (Chinese).

**Last reviewed**: 2026-09-08

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

### Defect Report Content

[Issue #41](https://github.com/hailingu/PlotWeave/issues/41) is the reference
example for the defect-report format. The rules and reusable template below
capture that format locally; the live issue is illustrative, not a separate
source of policy. Keep the six required headings in the order above.

- **Environment** records the relevant platform, configuration, entry point,
  and version. Distinguish the inspected code revision from the running app
  version when they have not been matched. Explain the severity using the
  observed impact and any verified workaround.
- **Steps to Reproduce** gives numbered actions and the precise trigger.
  State whether the report was independently reproduced and whether the
  trigger is intermittent. Label constructed minimal examples explicitly;
  they MUST NOT be presented as captured requests, responses, or logs.
- **Expected** describes the observable successful behavior and existing
  guarantees that a fix must preserve, such as user confirmation before
  applying changes. Proposed behavior beyond an established contract MUST
  be identified as a proposal rather than an existing requirement.
- **Actual** records the observed failure, relevant diagnostic text, and
  effect on the user's work. Separate user-reported behavior from what a
  screenshot or local reproduction directly demonstrates.
- **Evidence** connects stable code references and symbols to the behavior,
  separates confirmed causes from hypotheses, and states missing evidence.
  Record verification commands with their working directories, results, and
  limits; explicitly say when tests or live reproduction were not run.
  Passing existing tests MUST NOT be described as proof that the reported
  defect does not exist. Include focused repair suggestions and observable
  acceptance criteria here when available; proposals do not authorize an
  implementation or a contract change.
- **Regression Source** identifies the introducing commit only when known.
  Otherwise say it is unknown; an analysis baseline MUST NOT be described
  as the introducing commit without evidence.

Screenshots and logs SHOULD be attached or linked through a location readers
can access. If evidence exists only in the reporting conversation, state
that limitation and describe the relevant observation. A local temporary
file path MUST NOT be presented as a GitHub-accessible attachment. Exclude
secrets and unnecessary sensitive data from all evidence.

Scale detail to the defect. Unknown information should be marked as such;
creating an actionable issue does not require a completed investigation,
new tests, or a speculative root cause. Within Evidence, use short lead-in
paragraphs as in #41; use subheadings only when needed for readability.

### Reusable Defect Template

Replace the placeholders with supported facts. Keep required headings and
remove inapplicable optional detail rather than inventing evidence.

````markdown
## 环境 (Environment)

- 平台、相关配置与操作入口：<已知信息；未知项注明待确认>。
- 应用运行版本：<版本或待确认>；分析代码版本：<如已检查，填写 commit SHA>。
- 严重性：P<1|2|3>。<触发条件、影响，以及已验证的绕过方式（如有）>。

## 复现步骤 (Steps to Reproduce)

1. <准备状态与入口>
2. <触发操作或输入>
3. <观察位置>

复现状态：<用户报告 / 本地已复现；频率或尚未确认的条件>。
<如附最小输入，注明是实际捕获还是构造示例。>

## 期望结果 (Expected)

<用户可观察的正确结果，以及必须保留的既有保证。>

## 实际结果 (Actual)

- <观察到的失败现象与相关错误文案>
- <对当前操作、画布或数据的影响>

## 证据 (Evidence)

<截图、日志或录屏的可访问链接；无法提供附件时说明证据来源与限制。>

固定版本代码证据（如已检查）：

- [<符号或模块>](<包含 commit SHA 的代码链接>)：<该处行为与问题的关系>。

原因分析：<已确认的原因；待验证的推测及缺失证据分别说明>。

验证情况：<工作目录、实际执行命令、结果和未执行项；未运行则明确说明>。

建议修复与验收（如已有建议）：

- <针对本问题的修复方向，标明仍需确认的方案>
- <可观察、可验证的成功条件与回归场景>
- <应保留的行为或需要另行确定范围的契约变更>

## 回归来源 (Regression Source)

<已确认的引入提交及依据；未知则注明尚未定位，分析基线不代表引入版本。>
````

## Closing

An issue closes only with the resolving commit referenced in a comment
or, for known boundaries and resolved-without-change dispositions, with
the rationale and evidence recorded per the AGENTS.md Review And Response
Policy. Bulk-closing without a disposition record is not permitted.
