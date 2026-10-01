# 推送门禁与对象身份

维护逐 ref 分派、验证矩阵、残余边界及历史错配证据。本篇由[成本决策记录](quality-gate-cost.md#文档组织约定issue-472)
按 [issue #472](https://github.com/hailingu/PlotWeave/issues/472) 拆出，是该主题详细证据的唯一维护位置。
成本基线、重新评估触发条件与复测方法仍在[决策正文](quality-gate-cost.md#measured-baseline)。
沿用原记录的英文证据，保留测量日期、已实施修复与未验证边界；本次未新增行为或复测结论。

**整理日期**：2026-10-01

## Push-Path Per-Ref Gating (issue #405)

Before issue #405, `.githooks/pre-push` read no input and always scanned the
checked-out working tree, so pushing a non-checked-out ref, several refs at
once, or the checked-out branch with a dirty tree let states reach the
remote that the gate had never analyzed (the founding record of that finding
is retained below in
[Known Finding: Push Scans The Checked-Out Tree, Not The Pushed
Ref](#known-finding-push-scans-the-checked-out-tree-not-the-pushed-ref)).
The issue #405 fix, wired 2026-09-30, closes it:

- **Read stdin.** The hook consumes every line Git hands it
  (`<local ref> <local sha> <remote ref> <remote sha>`) before dispatching,
  so no child process can consume the hook's input, and the ref list cannot
  be influenced by gate execution.
- **Fast path — current working tree.** Taken only when the pushed commit
  (the local sha peeled to a commit, so annotated tags analyze the commit
  they point at) equals `HEAD` **and** the tree is provably identical to it:
  `git diff --quiet HEAD` (no unstaged or staged tracked differences),
  `git diff --cached --quiet HEAD` (index equality, so the record's
  `write-tree` key matches the pushed tree), and no untracked non-ignored
  file anywhere in the repository. Vitest can discover tests outside the
  maintained source trees, and their imports can read helpers or fixtures
  with any extension; a directory or test-suffix allowlist cannot establish
  input equality (PR #442 review 5361127076). Untracked documentation also
  triggers isolation; ignored generated artifacts retain the existing fast
  path behavior.
  The complete gate then runs exactly as before, at the same cost.
- **Slow path — temporary worktree.** Every other commit — a non-checked-out
  ref, a dirty worktree, or an additional distinct commit in a multi-ref
  push — is checked out with
  `git worktree add --detach` into a `mktemp` directory, dependencies are
  installed from that tree's lockfiles (`npm ci`), and the **current**
  gate scripts run the complete sequence with
  `PLOTWEAVE_GATE_REPOSITORY_ROOT` pointing at that worktree. The user's
  working tree is never touched by the slow path; the temporary worktree is
  removed after the
  run (best-effort `git worktree remove --force` on every exit path;
  residue is disk waste only, `git worktree prune` recovers it). The
  fast/slow choice is made **per unique pushed commit**, not per
  invocation: a multi-ref push that includes `HEAD` still gates `HEAD` in
  the current working tree — writing the same gitignored coverage, scanner,
  and Cargo artifacts every commit gate writes — and gates every other
  commit in its own temporary worktree; the mixed-dispatch case is pinned
  by the `pre-push-refs` multi-ref test.
- **Dedup and deletions.** Refs pointing at the same commit (a branch and
  its tag) are analyzed once; a ref deletion (all-zero local sha) exports no
  code and is skipped; a malformed ref line or a local sha that does not
  peel to a commit fails closed. Every ref line is analyzed or rejected —
  none is silently ignored.
- **Evidence and serialization.** Slow-path runs write their gate-history
  record through the main worktree's pending file and take the main
  worktree's gate lock, so fast path, slow path, and `materialize` stay
  serialized on one mutex and the record's `tree`/`head` are the pushed
  commit's (issue #355 semantics unchanged). All refs must pass before
  `materialize` runs; a failure blocks the push with earlier passing records
  left pending for the next successful push.
- **Original object identity.** The hook exports `GIT_NO_REPLACE_OBJECTS=1`
  before any Git command. Resolution (including annotated-tag peeling),
  fast-path comparisons, temporary checkout, and descendant gate records
  all read the original objects that push transfers. Local replacement refs
  remain installed; a working tree already materialized from a replacement
  fails the raw-object equality check and takes the slow path. This follows
  [Git's replacement-object semantics](https://git-scm.com/docs/git-replace)
  and closes the new trigger in
  [PR #442 review 5361127076](https://github.com/hailingu/PlotWeave/pull/442#pullrequestreview-5361127076).

**Review regression matrix (PR #442 review 5361127076).** `pre-push` owns
object resolution and dispatch; the gate owns the recorded tree and HEAD.
The tests run real Git, worktrees, hooks, and ledger writes; dependency,
coverage, and remote Sonar commands use the existing controlled substitutes.

| State and transition | Observable result and invariant | Verification in `scripts/pre-push-refs.test.ts` |
| --- | --- | --- |
| Non-HEAD pushed commit has a replacement → push | Scanner tree and ledger equal the original tree; remote receives the original SHA | Replacement-object non-checked-out test |
| HEAD's replacement content is already checked out → push | Slow path analyzes the original tree; local replacement content is preserved | Replacement-content HEAD test |
| Clean original HEAD has a replacement ref → push | Original tree remains eligible for the fast path | Clean HEAD replacement-ref test |
| Untracked nested test, imported fixture, or document → push | Slow path excludes the local input; local file remains intact and worktree is cleaned | Parameterized untracked-input tests |
| Slow-path gate fails → push | Push is blocked, remote ref is absent, and temporary worktree is removed | Existing slow-path failure test |
| Outer slow-path gate exports its root → nested test sandbox runs hooks | Each sandbox analyzes and records its own tree; outer gate root cannot leak into it | Root-isolation regressions in pre-push-refs and gate-tree-marker suites |

The first real slow-path push of this review fix exposed root-override
inheritance in those two test fixtures: four tests failed, so the hook
blocked the push. Their scenario environments must explicitly bind the
gate root to their own sandbox; production slow-path subprocesses continue
to override it with the actual pushed commit's temporary worktree.

Annotated tags use the same disabled-replacement resolution and retain the
existing branch-plus-tag regression. Separate tag-, tree-, and blob-object
replacement fixtures remain unverified: they share the process-wide Git
switch rather than a distinct dispatch branch. Concurrency and retry
ordering are unchanged; existing gate-history tests cover the shared lock.
The standalone Vitest `list --filesOnly` probe also confirmed that the
repository's actual configuration discovers `tests/boost.test.ts`; the
isolation tests verify scanner inputs rather than a coverage-inflation
percentage. No live Sonar scan is asserted by this regression suite.

**Known boundaries.** The fast path's equality proof is bounded by what git
can see: ignored files (e.g., a file hidden by `.git/info/exclude` inside
`src/`) and tracked differences masked by `skip-worktree` or
`assume-unchanged` are invisible to `git diff` / `git status` and can still
make the analyzed content differ from the pushed commit — the pre-#405
residuals, now narrowed from "always possible" to "fast path only". The slow
path's pristine checkout closes both. The slow-path subprocesses also strip
the worktree-localization variables git exports to commit-creating hooks
(`GIT_INDEX_FILE`, `GIT_PREFIX`, …): they resolve relative to the invoking
worktree and are invalid inside a temporary worktree — without the strip,
a gate run nested inside a commit hook (which is exactly how this
repository's own script tests execute under `npm run test:coverage`) would
break the slow path. Both paths analyze with the gate
definition of the current working tree (uniform-gate rule), so a pushed tree
older than the tooling itself fails closed if it lacks `package-lock.json`
(`npm ci`) or the files the gate needs; pushing such an ancient tree requires
checking it out first. Using `--no-verify` on the push remains prohibited and
is unaffected by this wiring.

The measured cost of both paths is recorded in
[Measured Baseline](quality-gate-cost.md#measured-baseline): the fast path is the unchanged
complete-gate cost (the refreshed baseline measures it); the slow path adds
dependency installation and cold caches and was measured once on landing —
see
[Push-Path Slow-Path Cost](quality-gate-cost.md#push-path-slow-path-cost-2026-09-30-issue-405).

## Known Finding: Push Scans The Checked-Out Tree, Not The Pushed Ref

**Update 2026-09-30 (issue #405 fix)**: this finding is closed. `.githooks/
pre-push` now reads the refs Git hands it on stdin and gates every pushed
ref at that ref's commit state — in the current working tree only when it is
provably identical to the pushed commit, otherwise in a temporary worktree
checked out at that commit (see
[Push-Path Per-Ref Gating](#push-path-per-ref-gating-issue-405)). The
equality proof covers tracked differences (staged and unstaged) and
untracked non-ignored files anywhere in the repository; ignored inputs and
differences hidden by `skip-worktree` /
`assume-unchanged` remain outside what git can prove and are recorded as
fast-path residuals there — the slow path's pristine checkout closes both.
The founding text below is retained as the pre-fix measurement.

`.githooks/pre-push` reads no input. Git hands the hook the refs about to be
pushed on standard input; the hook ignores it and runs
`sonar-quality-gate.sh` against the current working tree. So when a developer
pushes a ref other than the checked-out branch — `git push origin other-branch`,
several refs at once, or `--all` — the gate analyzes and passes on the
**checked-out** tree, and the commit actually pushed may never have been
analyzed at all.

Branch identity is not sufficient either. The hook scans the **working tree**,
not the pushed commit, so a push can pass on state the pushed commit does
not contain. The first variant is uncommitted work: after committing state A
on the checked-out branch, an uncommitted change B means `git push` sends A
while the gate's tests and scanner inspect B, so the gate can pass on B and
A reaches the remote never analyzed. The second is ignored files: "clean"
does not exclude them, because `.git/info/exclude` (or any ignore rule)
hides a file from `git status` yet not from the gate. With `src/local.ts`
excluded and this repository's `tsconfig.json` including all of `src`, a
push of HEAD state A leaves `git status` clean while `pre-push` analyzes A
plus the ignored file B (评审 4115241706). Measured on git 2.48.1:
`git status --porcelain` was empty, the push sent only A, and the hook read
the ignored `src/local.ts`. So even a push that matches the checked-out
branch with no reported changes can analyze a tree the pushed commit does
not contain.

Tracked changes can also be invisible to `git status`: in isolated Git
2.48.1 probes, marking `src/local.ts` with `skip-worktree` or
`assume-unchanged` and then changing its contents left `git status
--porcelain` empty while the file differed from `HEAD` (评审 4115510915).
The working-tree version passed TypeScript checking while the committed
version failed it, with no ignored input involved. These flags have
[different documented purposes](https://git-scm.com/docs/git-update-index#_skip_worktree_bit);
neither makes clean status proof that the analyzed contents match the
pushed commit. The same hidden tracked difference can affect the
comparison with the selected commit tree at commit time.

The plumbing path also has a push-side variant with no local ref update:
`git push <remote> <oid>:refs/heads/…` sends a commit object that no local
ref points at, so no local `reference-transaction` fires and `pre-push`
again analyzes the unrelated checked-out tree (评审 4115241708). Measured on
git 2.48.1: such a push installed the object on the remote
(`refs/heads/direct`) while the local hook log shows only `pre-push` reading
the pushed OID from stdin and no `reference-transaction` entry. Only the
[implemented per-ref remedy](#push-path-per-ref-gating-issue-405) can close this one.

`git subtree push --prefix=<prefix> <repository> <refspec>` has the same
push-side mismatch, while also creating the commits it pushes. In a Git
2.48.1 two-commit fixture, the command created a rewritten split chain and
pushed its tip directly without updating the checked-out branch. `pre-push`
received the split-tip OID while `HEAD` remained the distinct full-project
commit scanned by the gate. A `reference-transaction` callback updated the
local remote-tracking ref only after the bare remote accepted the push, too
late to block it. The push-side mismatch is tracked in #405 and requires
analyzing the pushed split tip.

Adding `--rejoin` changes the local history transition but not the pushed-tip
identity. In a Git 2.48.1 fixture with new subtree content, `git subtree push
--rejoin` created a two-parent merge on the checked-out branch; its
`reference-transaction` callback covered `refs/heads/main` before the push,
and `pre-merge-commit` fired. Then `pre-push` received the generated split-tip
OID while `HEAD` was the different rejoin merge commit (评审 4115812068).
Since issue #404, the wired `pre-merge-commit` gates that rejoin merge after
the earlier rejoin supplied subtree metadata, with same-operation tree-marker
dedup in `prepare-commit-msg`; the recheck above confirms this also holds
with `--squash` when that metadata is present.
`reference-transaction` remains unwired and split generation has no
commit-creation hook. The #405 wrong-tree scan described here is the
pre-fix measurement: the implemented per-ref push gate now analyzes the
pushed split tip at its own commit state.

Verified on 2026-09-27 with a local bare remote and a hook that logs both the
stdin refs and `HEAD`:

```
stdin (ref actually pushed): refs/heads/other 384b7636aea2…
HEAD (what the gate scans):  7db139eda9f2… (main)
```

Because CI does not run SonarQube (see the Scope Routing row for `.github/**`),
the push-time gate is the only SonarQube path on the push side; the same
script also runs on `git commit`, so the covered creation path has an earlier
analysis, subject to the commit-tree/working-tree mismatch in the [coverage inventory](quality-gate-enforcement.md#what-the-gate-actually-enforces). If no
earlier gate analyzed the pushed state, pushing a different ref can let it
reach the remote without any SonarQube pass for that state. Using
`--no-verify` likewise skips the push-time gate; it does not erase any
earlier analysis. This is a separate problem from the [commit-creation gaps](quality-gate-enforcement.md#known-finding-uncovered-commit-creation-paths), with a different
trigger and a different remedy, so it is tracked separately rather than folded
into #404: [#405](https://github.com/hailingu/PlotWeave/issues/405).
The commit-side counterpart — a commit analyzed on working-tree state it
does not contain (omitted staged changes, unstaged tracked changes, or
untracked/ignored inputs) — is recorded in
[What The Gate Actually Enforces](quality-gate-enforcement.md#what-the-gate-actually-enforces) as a
boundary of this inventory.
