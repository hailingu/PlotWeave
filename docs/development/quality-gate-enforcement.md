# 门禁命令覆盖与已知边界

维护完整命令清单、实测说明及未覆盖提交创建路径。本篇由[成本决策记录](quality-gate-cost.md#文档组织约定issue-472)
按 [issue #472](https://github.com/hailingu/PlotWeave/issues/472) 拆出，是该主题详细证据的唯一维护位置。
成本基线、重新评估触发条件与复测方法仍在[决策正文](quality-gate-cost.md#measured-baseline)。
沿用原记录的英文证据，保留测量日期、已实施修复与未验证边界；本次未新增行为或复测结论。

**整理日期**：2026-10-01

## What The Gate Actually Enforces

[The decision](quality-gate-cost.md#decision) describes intent. This section records the verified
*enforcement* boundary, so that no reader overstates the guarantee. It was
measured on 2026-09-27 against git 2.48.1 with isolated logging hooks selected
through `core.hooksPath`. The table records command-related observations in
the tested modes; shared index-write and ref-update callbacks are explained
below, rather than claiming an exhaustive trace for every command variant.

Since the issue #404 wiring this repository wires four hooks:
`.githooks/pre-commit`, `.githooks/pre-merge-commit`,
`.githooks/prepare-commit-msg`, and `.githooks/pre-push`, plus the shared
dedup helper `scripts/gate-tree-marker.sh`. There is no `commit-msg`,
`post-commit`, `post-merge`, `pre-rebase`, `post-rewrite`,
`pre-applypatch`, `applypatch-msg`, `reference-transaction`, or
`post-index-change`. The table below was measured on 2026-09-27 against
git 2.48.1 with only `pre-commit` and `pre-push` wired; the "Gate analyzes
this commit?" column has been updated for the new wiring where the measured
hook set determines it. The subtree squash/rejoin rows were rechecked on
2026-09-30 against the same git 2.48.1 after review 4141186822 contradicted
their original measurements; the remaining hook lists retain the original
measurements. The wired hooks now make the automatic merge / revert /
cherry-pick / rebase-replay / commit-side `--no-verify` paths reach the
gate.

Since the issue #405 fix (2026-09-30), every push-side mismatch this
inventory records — a pushed ref whose state differs from the checked-out
tree — is closed: `pre-push` reads stdin and analyzes each pushed ref at
that ref's own commit (fast path in the checked-out tree only under the
provable-equality preconditions, otherwise a temporary-worktree checkout;
see
[Push-Path Per-Ref Gating](quality-gate-push.md#push-path-per-ref-gating-issue-405)). The
per-row `#405` mentions below are retained as the pre-fix measurement of
which commands could produce such a mismatch; they identify the push-side
exposure those rows had before the fix, not a live gap.

The subtree narratives below were synchronized with both implemented hook
extensions on 2026-09-30 for
[issue #412](https://github.com/hailingu/PlotWeave/issues/412). Split generation
and synthetic squash commits remain ungated at creation. A resulting branch
merge/rejoin routed through `git merge --no-ff` is gated, including with
`--squash`; a first rejoin without prior subtree add/rejoin metadata instead
uses the ungated `subtree add` plumbing path. The recheck below distinguishes
these states rather than treating every `--squash` branch commit as ungated.
The subtree entries in the table describe creation-time coverage; the
push-time gate separately analyzes any split tip actually pushed.

| Command that creates a commit | Observed hooks (shared callbacks also described below) | Gate analyzes this commit? |
| --- | --- | :---: |
| `git commit` (without `--amend`) | `post-index-change` on index writes; `pre-commit`, `prepare-commit-msg`, `commit-msg`, `post-commit` | yes |
| `git commit --amend` | `post-index-change` on index writes; `pre-commit`, `prepare-commit-msg`, `commit-msg`, `post-commit`, then `post-rewrite amend` unless `--no-post-rewrite` | yes |
| `git merge` (automatic, conflict-free non-fast-forward merge commit) | `pre-merge-commit`, `prepare-commit-msg`, `commit-msg`, `post-merge` | **yes** (issue #404: wired `pre-merge-commit`) |
| `git merge --autostash` (dirty tracked worktree) | merge hooks above; autostash creates ref-less stash commits with no hook | **yes** for the merge commit; the autostash objects stay ungated |
| `git pull` (default merge mode, diverged upstream) | `pre-merge-commit`, `prepare-commit-msg`, `commit-msg`, `post-merge`; `reference-transaction` on fetch | **yes** (issue #404: wired `pre-merge-commit`) |
| `git pull --autostash` (default merge mode, dirty tracked worktree) | pull merge hooks above; autostash creates ref-less stash commits with no hook | **yes** for the merge commit; the autostash objects stay ungated |
| `git merge --continue` after resolving conflicts | `post-index-change`; `pre-commit`, `prepare-commit-msg`, `commit-msg`, `post-commit` | yes |
| `git revert` (automatic, conflict-free commit) | `prepare-commit-msg` + `post-commit` | **yes** (issue #404: wired `prepare-commit-msg`) |
| `git revert --continue` after resolving conflicts | `post-index-change`; `pre-commit`, `prepare-commit-msg`, `commit-msg`, `post-commit` | yes |
| `git cherry-pick` (automatic, conflict-free commit) | `prepare-commit-msg` + `post-commit` | **yes** (issue #404: wired `prepare-commit-msg`) |
| `git cherry-pick --continue` after resolving conflicts | `post-index-change`; `pre-commit`, `prepare-commit-msg`, `commit-msg`, `post-commit` | yes |
| `git rebase` replaying commits onto a new base | `pre-rebase` once, then `prepare-commit-msg` + `post-commit` per replayed commit, `post-rewrite` once at the end | **yes** (issue #404: wired `prepare-commit-msg`, one full gate per replayed commit) |
| `git rebase --autostash` (dirty tracked worktree) | rebase hooks above; autostash creates ref-less stash commits with no hook | **yes** for replayed commits; the autostash objects stay ungated |
| `git rebase --update-refs` (other branches in the rebased range) | rebase hooks above; secondary branches move via `reference-transaction` only — no gate for their new tips | **yes** for replayed commits; secondary tips **no** * |
| `git rebase --continue` after resolving a conflict | `post-index-change`, `prepare-commit-msg`, `post-commit`, `post-rewrite`; no `pre-commit` | **yes** (issue #404: wired `prepare-commit-msg`) |
| `git am` applying a patch series | `applypatch-msg`, `pre-applypatch`, `post-applypatch` — none wired | **no** |
| `git stash push` / `git stash` / `git stash save` (tracked changes) | `reference-transaction`; no commit-creation hooks | **no** * |
| `git stash push -u` / `--all` | `reference-transaction`; no commit-creation hooks; additionally creates an ungated third "untracked files" parent commit | **no** * |
| `git stash create [<message>]` (tracked changes) | `post-index-change` on index writes; no commit-creation or ref-update hooks | **no** |
| `git notes add` / `append` / `edit` / `copy` / `remove` / `merge` / `prune` | `reference-transaction`; no commit-creation hooks | **no** * |
| `git commit-tree` + `git update-ref` (plumbing) | `reference-transaction`; no commit-creation hooks | **no** * |
| `git hash-object -t commit -w --stdin` + `git update-ref` (plumbing) | `reference-transaction` on ref update only; `hash-object` itself fires no hook | **no** * |
| `git replace [-f] <object> <replacement>` / `git replace --graft <commit> [<parent>…]` / `git replace --edit <commit>` / `git replace --convert-graft-file` | `reference-transaction`; no commit-creation hooks | **no** * |
| `git fast-import` (`commit <ref>` stream) | `reference-transaction`; no commit-creation hooks | **no** * |
| `git quiltimport` (applies a quilt patchset to the current branch) | `post-index-change`; `reference-transaction`; no commit-creation hooks | **no** |
| `git filter-branch` (history rewrite) | none measured here (see note) | **no** * |
| `git lfs migrate import` / `export` / `import --no-rewrite` (extension) | reviewer probe only (git-lfs 3.4.1): shared index/ref/checkout callbacks, no commit-creation hooks; not measured here (git-lfs absent) | **no** * |
| `git subtree split --prefix=<dir> --branch <branch>` | `reference-transaction`; no commit-creation hooks | **no** * |
| `git subtree split --prefix=<dir> [<commit>]` (no `--branch`) | none measured here; no ref updated | **no** ** |
| `git subtree merge --prefix=<prefix> <commit>` (automatic non-fast-forward merge) | `post-index-change`; `pre-merge-commit`, `prepare-commit-msg`, `commit-msg`, `post-merge`; shared `reference-transaction` | **yes** (issue #404: wired `pre-merge-commit`) |
| `git subtree merge --prefix=<prefix> --squash <commit>` (new subtree content after an earlier add/rejoin) | synthetic squash commit has no creation hook; branch merge fires `pre-merge-commit`, `prepare-commit-msg`, `commit-msg`, `post-merge`; shared index/ref callbacks | **yes** for the branch merge (issue #404); synthetic squash commit **no** |
| `git subtree pull --prefix=<prefix> <repository> <ref>` (automatic non-fast-forward merge) | `reference-transaction` on fetch; then the subtree merge hooks above | **yes** (issue #404: wired `pre-merge-commit`) |
| `git subtree pull --prefix=<prefix> <repository> <ref> --squash` (new subtree content after an earlier add/rejoin) | `reference-transaction` on fetch; then the subtree merge `--squash` hooks above | **yes** for the branch merge (issue #404); synthetic squash commit **no** |
| `git subtree split --rejoin --prefix=<prefix>` (new subtree content after an earlier add/rejoin) | split commits have no commit hook; automatic rejoin merge fires `pre-merge-commit`, `prepare-commit-msg`, `commit-msg`, `post-merge`; shared index/ref callbacks | **yes** for the rejoin merge (issue #404: wired `pre-merge-commit`); split commits **no** |
| `git subtree split --rejoin --squash --prefix=<prefix>` (new subtree content after an earlier add/rejoin) | split and synthetic squash commits have no creation hook; rejoin merge fires `pre-merge-commit`, `prepare-commit-msg`, `commit-msg`, `post-merge`; shared index/ref callbacks | **yes** for the rejoin merge (issue #404); split and synthetic squash commits **no** |
| `git subtree split --rejoin [--squash] --prefix=<prefix>` (first rejoin of a plain directory, no prior add/rejoin metadata) | `subtree add` plumbing creates the rejoin; shared index/ref callbacks only; `--squash` also creates a ref-less synthetic squash commit | **no** for rejoin, generated split, or synthetic squash commits |
| `git subtree push --prefix=<prefix> <repository> <refspec>` | `pre-push` receives split tip; `reference-transaction` may update `refs/remotes/origin/*` after the push; no commit-creation or checked-out-branch ref-update hook | **no** (for generated split commits) |
| `git subtree push --prefix=<prefix> --branch <branch> <repository> <refspec>` | `reference-transaction` on the new local branch; then `pre-push` receives split tip | **no** (for generated split commits; branch creation is a #404 closure candidate) |
| `git subtree push --rejoin --prefix=<prefix> <repository> <refspec>` (automatic conflict-free rejoin after an earlier add/rejoin) | rejoin merge: `post-index-change`, `pre-merge-commit`, `prepare-commit-msg`, `commit-msg`, `reference-transaction` on the checked-out branch, `post-merge`; then `pre-push` receives split tip | **yes** for the rejoin merge (issue #404: wired `pre-merge-commit`); generated split commits **no** |
| `git subtree push --rejoin --squash --prefix=<prefix> <repository> <refspec>` (new subtree content after an earlier add/rejoin) | rejoin merge with `--squash` hooks above; synthetic squash commit has no creation hook; then `pre-push` receives split tip | **yes** for rejoin merge (issue #404); synthetic squash and generated split commits **no** |
| `git subtree push --rejoin [--squash] --prefix=<prefix> <repository> <refspec>` (first rejoin of a plain directory, no prior add/rejoin metadata) | `subtree add` plumbing creates the rejoin with shared index/ref callbacks only; then `pre-push` receives split tip | **no** at creation for rejoin, generated split, or synthetic squash commits; pushed split tip is gated by #405 |
| `git subtree add --prefix=<prefix> <commit>` | `post-index-change` on index writes; `reference-transaction`; no commit-creation hooks | **no** |
| `git subtree add --prefix=<prefix> --squash <commit>` | `post-index-change` on index writes; `reference-transaction`; no commit-creation hooks; additionally creates a ref-less synthetic squash commit | **no** |
| `git merge --squash` / `--no-commit` followed by `git commit` | `pre-commit`, … | yes |
| `git commit --no-verify` (without `--amend`) | `post-index-change` on index writes; `prepare-commit-msg`, `post-commit` | **yes** (issue #404: `--no-verify` skips `pre-commit` but not `prepare-commit-msg`) |
| `git merge --no-verify` | `prepare-commit-msg`, `post-merge` | **yes** (issue #404: wired `prepare-commit-msg` still fires) |
| `git commit --amend --no-verify` | `post-index-change` on index writes; `prepare-commit-msg`, `post-commit`, then `post-rewrite amend` unless `--no-post-rewrite` | **yes** (issue #404: wired `prepare-commit-msg` still fires) |

\* These rows produce commits under refs that are **pushable by explicit
refspec** — `git push <remote> refs/stash:refs/heads/…`, `refs/notes/*`,
`refs/replace/*`, `refs/heads/<branch>` from the subtree split, or the branch
`update-ref` just created — so each carried the same
remote-facing gap tracked in
[Known Finding: Push Scans The Checked-Out Tree, Not The Pushed
Ref](quality-gate-push.md#known-finding-push-scans-the-checked-out-tree-not-the-pushed-ref):
before the issue #405 fix, `pre-push` analyzed the checked-out tree, not the
pushed ref (评审 4115165662, 4115165667). Since that fix (2026-09-30) the
gap is closed — each pushed ref is analyzed at its own commit. The
`commit-tree` and `hash-object` rows
additionally have a direct-OID push variant that causes no local
`reference-transaction` — `update-ref` is optional for both, and the
returned OID can be pushed as-is; `pre-push` still receives the OID and can
block the push. See the commit-tree paragraph below.

\*\* This row produces a commit object without updating any ref, so no local
`reference-transaction` fires for it. The commit can be published in two
ways: installed on a local branch first (`git update-ref refs/heads/…
<oid>`), which fires `reference-transaction` and is a #404 closure
candidate, then pushed normally; or pushed directly by OID (`git push
<remote> <oid>:refs/heads/…`), which is the #405 push-side gap.

`post-index-change` is a shared index-write callback, as specified by its
[Git contract](https://git-scm.com/docs/githooks#_post_index_change), rather
than a commit-creation gate (评审 4115577716). Any command that reaches that
index-writing path can invoke it; its occurrence and count depend on the
index writes performed. Git 2.48.1 probes of ordinary commit, amend, both
corresponding `--no-verify` forms, and `commit --only A` all invoked it.
When `pre-commit` was enabled, the observed index callbacks preceded it;
`--only A` produced two index callbacks rather than one. All five commands
committed the expected tree and exited 0 with `post-index-change` configured
to exit 1, so it cannot supply a blocking gate. Other rows do not enumerate
every shared index callback; their index-write traces were not remeasured
here, and omission from a row does not mean the callback cannot fire.
This repository does not wire it, so the Gate column remains unchanged.

Every command in this table also fires `reference-transaction` on the ref
updates it performs — measured on git 2.48.1 for `git commit`
(`refs/heads/*`), `git merge`, `git cherry-pick`, and `git stash push`
(`refs/stash`) — and the per-row hook lists omit it because it is not
commit-creation-specific (评审 4114992022). The `git filter-branch` row is
the exception: its entry here is unverified because our Git 2.48.1
measurement fired no hook at all while a Git 2.43 run reported it (评审
4115347192), so do not treat `reference-transaction` as a verified closure
for that path. This repository does not wire it,
so the Gate column is unaffected. Note that a nonzero exit in its `prepared`
state aborts the ref update, which makes it the one hook type that could in
principle gate these paths; whether to do so is a #404 hook-design question,
not part of the cost decision.

`git commit --amend` also calls `post-rewrite` with argument `amend` after
`post-commit`, as the [post-rewrite contract](https://git-scm.com/docs/githooks#_post_rewrite)
specifies (评审 4115510916). Measured on Git 2.48.1: both ordinary amend and
amend with `--no-verify` invoked it with the old/new commit OIDs on stdin;
both completed and changed `HEAD` even when that hook exited 1. It therefore
cannot block the rewrite. `--no-verify` skips `pre-commit` and `commit-msg`,
not `post-rewrite`; the separate `--no-post-rewrite` option suppresses the
latter, also confirmed by the probe. Ordinary amend reaches the existing
`pre-commit` gate; since the issue #404 wiring, amend with `--no-verify` is
still gated, because `--no-verify` does not skip `prepare-commit-msg`, which
finds no reusable marker and runs the complete gate.

`git revert` and `git cherry-pick` do not accept `--no-verify` at all
(`git revert -h` / `git cherry-pick -h` list no such option), so they are
absent from the bypass rows rather than bypassable through them. Their automatic
commits run `prepare-commit-msg` and `post-commit` — **not** `commit-msg`, which
`githooks(5)` documents as applying to `git commit` and `git merge`
(评审 4114854376). Like the rebase row, `post-commit` fires only once the commit
exists and git ignores its exit status, so it cannot implement a blocking gate
either. `post-merge` on the merge rows is likewise after the fact: it fires
after the merge has completed and cannot block it.

`git pull` in its default merge mode is the same automatic merge commit as
`git merge` plus a fetch: measured on git 2.48.1 with a diverged upstream, it
fired `reference-transaction` on the fetch, then `pre-merge-commit`,
`prepare-commit-msg`, `commit-msg`, and `post-merge` — no `pre-commit`
(评审 4117872584). Since the issue #404 wiring the wired `pre-merge-commit`
gates that merge commit like `git merge` itself. Its `--rebase` modes enter
the rebase path, whose replayed commits are gated per pick through
`prepare-commit-msg`. `git pull` is the commonest entry point for merges, so
it is listed separately rather than folded into the `git merge` row.

`--autostash` on `merge`, `pull`, or `rebase` adds another ref-less path:
the option stashes dirty tracked changes before the operation and pops them
after, creating stash commit objects without any commit-creation hook or
`reference-transaction` for those objects (评审 4117983619). Measured on git
2.48.1, `git merge --autostash` printed the temporary stash OID and created
both the stash and index-parent commits with no hook firing for them; the
printed OID remains directly pushable, giving these variants the same
ref-less #404/#405 boundary already documented for `stash create`.

The conflict path is different for merge, revert, and cherry-pick. In Git
2.48.1 fixtures, each automatic command stopped on a content conflict; after
resolving and staging the file, its documented `--continue` command invoked
`pre-commit` before creating the resulting commit. That runs this repository's
gate, subject to the working-tree-versus-commit-tree boundary described later in this section. These
continuations are therefore covered by `pre-commit` (评审 4115865924); since
the issue #404 wiring, their automatic conflict-free commit paths are covered
as well — merges through `pre-merge-commit`, revert and cherry-pick through
`prepare-commit-msg` — so both paths of these commands are now gated. A
conflict-resolved
`git rebase --continue` was also measured: it ran `prepare-commit-msg`,
`post-commit`, and `post-rewrite`, but not `pre-commit`; since the issue #404
wiring, `prepare-commit-msg` runs the gate, so the continuation is covered
like every other replayed rebase commit.

`git rebase` and `git am` were measured on 2026-09-27 (git 2.48.1, isolated
hook log, two commits replayed / one patch applied) with this repository's
wiring absent, so the rows above record which hooks *would* fire: a
commit-producing rebase runs `pre-rebase` once and then `prepare-commit-msg`
and `post-commit` per replayed commit — **`pre-commit` and `commit-msg` never
fire** — and `post-rewrite` once after the replay, whose exit status git
ignores, so it cannot implement a blocking gate either (评审 4114827177);
the command-specific hooks for `git am` are the applypatch family, none of
which this repository wires. Shared index/ref callbacks are covered above.
Since the issue #404 wiring these two paths diverge: the wired
`prepare-commit-msg` gates each replayed rebase commit, while `git am`
remains the ungated path — none of the applypatch family is wired. With
`--update-refs`,
rebase additionally moves other local branches that point into the rebased
range: measured on git 2.48.1, `git rebase --update-refs --onto <newbase>
HEAD~2` moved a secondary branch to the replayed intermediate commit via
`reference-transaction` only (评审 4119009208). That branch's tree can
differ from the checked-out rebased tip, so pushing it makes `pre-push`
scan the checked-out tree rather than the branch being published — the same
#405 pushed-ref mismatch, marked `*` in the table.

`git stash push` with tracked changes creates its entry commits under
`refs/stash` — the stash commit plus its index parent — without running any
commit-creation hook (评审 4114895001); the `git-stash` documentation likewise
describes a stash entry as a commit. The bare `git stash` shorthand and the
legacy `git stash save` form behave identically — measured on git 2.48.1,
each created the stash and index-parent commits with only shared index/ref
callbacks firing (评审 4118565852). With `-u` / `--all`, the stash commit
gains a third "untracked files" parent commit that is likewise created
ungated. Stashed work normally re-enters the tree
through `git stash pop` / `apply`, which create no commits, and becomes
commits only through the paths this table already records. Its ref-update hook is
`reference-transaction` on the `refs/stash` update, and aborting that update
in the `prepared` state does prevent the entry — measured: with such a hook
`git stash push` fails with exit 128 ("ref updates aborted by hook") and
`refs/stash` keeps its previous value — though the entry's objects are
already written by then (评审 4114992022). Stash therefore remains within
#404's hook-design scope rather than being excluded as unwireable.

`git stash create [<message>]` is a separate, ref-less path. With modified
tracked content, it returns the new stash commit's OID without changing
`HEAD`, `refs/stash`, or another local ref. A Git 2.48.1 probe recorded only
shared `post-index-change` callbacks (four index writes); no commit-creation
hook or `reference-transaction` fired. That callback cannot block the object
creation. If the returned OID is pushed directly, `pre-push` receives that
OID while the gate scans the checked-out tree. In the probe, an untracked
source file remained in the working tree but was absent from the stash commit
tree, demonstrating the #405 mismatch. A local `reference-transaction` hook
cannot close the creation path unless the object is first installed in a ref, so that
limitation belongs in #404's hook-design inventory as well.

The stash commits are also pushable: an explicit refspec such as
`git push <remote> refs/stash:refs/heads/…`, or `--mirror`, copies the stash
commit to the remote while `pre-push` analyzes the unrelated checked-out
tree (评审 4115165662) — measured on git 2.48.1, `git push <remote>
refs/stash:refs/heads/stashed` created a new remote branch holding the exact
stash commit. So stash does not, after all, stay purely local; its push-side
exposure is the [historical push finding](quality-gate-push.md#known-finding-push-scans-the-checked-out-tree-not-the-pushed-ref), tracked there rather than re-counted
here.

`git notes add` / `append` / `edit` / `copy` / `remove` / `merge` / `prune`
likewise create commits under `refs/notes/*` (by default `refs/notes/commits`)
without any commit-creation hook — measured on git 2.48.1, only
`reference-transaction` fires (评审 4115135524, 4117675234, 4117735042).
Notes refs are pushable (`git push origin refs/notes/*`), so this row is
remote-facing in the same sense the push finding is; it is recorded here as
a boundary and its closure — `reference-transaction` in `prepared` state —
is the same #404 option noted for stash, not a separate remedy.

`git replace [-f] <object> <replacement>` points the target at an existing
replacement object, creating `refs/replace/<target-oid>` without any
commit-creation hook — measured on git 2.48.1, only `reference-transaction`
fired (评审 4118343207). The ordinary form shares the same ref-backed
exposure and #404/#405 disposition as the specialized forms below.

`git replace --graft <commit> [<parent>…]` creates a replacement commit with
the target commit's tree and the supplied parent list, then stores it under
`refs/replace/<target-oid>`. Git commands use that replacement by default, so
it can change the effective history seen by local commands without moving a
branch ref. Measured on git 2.48.1 with a two-commit fixture, grafting the
child to have no parent preserved its tree, created a distinct replacement
commit, and fired only `reference-transaction` (in `prepared` and `committed`
states); no commit-creation hook fired. An explicit push of that individual
`refs/replace/<target-oid>` ref installed the replacement ref on a local bare
remote. The local closure is therefore the same #404
`reference-transaction` design question as the other ref-backed paths, and
the explicit-push exposure belongs to #405.

`git replace --edit <commit>` creates the same kind of replacement ref after
editing the commit object in the configured editor. Measured on git 2.48.1
with an isolated commit fixture, changing its message created a distinct
replacement commit under `refs/replace/<target-oid>` and fired only
`reference-transaction` (`prepared` and `committed`); no commit-creation hook
fired. Explicitly pushing that ref to a local bare remote succeeded. Its local
and push-side dispositions are therefore the same #404 and #405 paths as
`--graft`. `git replace --convert-graft-file` converts legacy
`.git/info/grafts` entries into `refs/replace/*` refs; measured on git
2.48.1 with a valid graft, it created the replacement commit and fired only
`reference-transaction` (`prepared` and `committed`), no commit-creation
hook (评审 4117675234). Its local and push-side dispositions are the same
#404 and #405 paths as `--graft` and `--edit`.

The plumbing path is uncovered too: `git commit-tree <tree>` creates a
commit object directly, and `git update-ref refs/heads/<branch> <commit>`
places it on branch history, without any commit-creation hook — measured on
git 2.48.1, only `reference-transaction` fired during the ref update
(评审 4115165667). One level lower, `git hash-object -t commit -w --stdin`
writes the commit object itself; measured on git 2.48.1, piping a valid
commit payload created the object with an empty hook log (评审 4117675224).
The resulting OID can then be installed with `update-ref` or pushed
directly, so `commit-tree` is not the lowest-level route after all. Like
the other off-hook paths their local ref-update closure is the same #404
`reference-transaction` question. `git fast-import` reaches the same
place from a stream: its `commit <ref>` command creates the commit and
updates the branch in one step — measured on git 2.48.1, importing one
commit into `refs/heads/imported` fired only `reference-transaction`
(prepared + committed, twice) and no commit-creation hook (评审 4115220196).
Because this repository does not wire that hook, such an import bypasses the
gate on the commit side entirely. `git quiltimport` is the user-facing
counterpart: it applies a quilt patchset onto the current branch, creating
each commit via the same `commit-tree` + `update-ref` plumbing — measured on
git 2.48.1 with a one-patch series, it landed the commit on branch history
with only `post-index-change` and `reference-transaction` firing, no
commit-creation hook (评审 4118728971). `git filter-branch` produced an empty
hook log in our measurement — no commit-creation hook and no
`reference-transaction` (git 2.48.1, `--env-filter` forcing a real rewrite).
The reviewer reports `reference-transaction` firing on Git 2.43 (评审
4115347192); we could not reproduce that here, so we record our measured
result and note the discrepancy rather than assert either way. This
repository does not wire `reference-transaction` regardless, so the gate
does not run for filter-branch; whether the hook is available as a closure
is a #404 question the two measurements leave open.

`git lfs migrate` is the first **extension** path in this inventory rather
than a git built-in. Reviewer probes on Git 2.43 with git-lfs 3.4.1 report
that `import` / `export` (which "rewrite your Git history" per
`git lfs migrate --help`) and `import --no-rewrite` (which creates a new
commit) all changed `HEAD` while firing only shared
index/ref/checkout callbacks — never `pre-commit` (评审 4118866986).
git-lfs is not installed in this measurement environment, so the row
records the reviewer's probe rather than a local measurement. The reviewer's
probe covered the HEAD-only default; the documented multi-ref modes —
`--everything` (migrate commits reachable from all refs) and
`--include-ref` selections — can additionally rewrite **non-checked-out**
branches and tags (评审 4118919110). Those rewritten refs are pushable while
`pre-push` scans only the checked-out tree, so the multi-ref modes carry the
same pushed-ref mismatch as multi-ref `filter-branch`: the #405 push-side
gap, marked `*` in the table. The same
class boundary extends to other third-party history rewriters —
`git filter-repo`, `git-annex` — which operate below the porcelain commit
path like the built-in rewriters above; they have not been probed here
either, so verify a given tool's hook behavior before relying on this
class statement.

`git subtree split --prefix=<dir> --branch <branch>` creates a rewritten
commit chain for the selected subtree and places its tip on the requested
branch. Measured on git 2.48.1 with a two-commit fixture, the split produced
two commits and fired only `reference-transaction` (`prepared` and
`committed`); no commit-creation hook fired. Explicitly pushing the resulting
branch to a local bare remote succeeded. The local ref-update closure is a
#404 `reference-transaction` design question, and pushing that branch while
the hook scans the checked-out tree is the #405 push-side gap.

`git subtree split --prefix=<dir> [<commit>]` without `--branch` is the
ref-less variant: it creates the same rewritten commit chain but prints only
its tip OID without updating any ref, and fires no hook at all (评审
4115953696). Measured on git 2.48.1, an isolated probe returned a new OID
with an empty hook log and `for-each-ref` unchanged. That OID is then
publishable by direct-OID push (`git push <remote> <oid>:refs/heads/…`),
which likewise runs no local hook against the pushed content; the push-side
gap is the same #405 remedy, and no local `reference-transaction` can
intercept the creation before that push.

`git subtree merge --prefix=<prefix> <commit>` and
`git subtree pull --prefix=<prefix> <repository> <ref>` both create a merge
commit on the checked-out branch. With divergent application and subtree
histories, Git 2.48.1 fixtures confirmed two-parent merge commits; each fired
`pre-merge-commit`, `prepare-commit-msg`, `commit-msg`, `post-merge`, shared
index callbacks, and `reference-transaction`, but neither fired `pre-commit`.
`pull` also fetched the source before the merge. Since issue #404, the wired
`pre-merge-commit` gates these automatic branch merge commits, with
`prepare-commit-msg` consuming the same-operation tree marker; the complete
gate runs once per merge. These commands do not themselves push a ref. If a
conflicting merge is continued with `git merge --continue`, that
continuation follows the `pre-commit` path documented above. With
`--squash`, both commands
additionally create a ref-less synthetic squash commit before the merge
(评审 4117872586): `git subtree -h` documents `--squash` for `merge` and
`pull` as well, and the synthetic commit already exists before the branch
transaction, so `reference-transaction` cannot close its creation; its
push-side exposure is the same #405 remedy. The 2026-09-30 recheck on git
2.48.1 corrected the earlier no-creation-hook measurement: with new subtree
content after a squash add, both `merge --squash` and `pull --squash` fire
`pre-merge-commit`, `prepare-commit-msg`, `commit-msg`, and `post-merge` for
the resulting two-parent branch merge. The hook index tree equals that
merge's tree. A separate rejection probe made `pre-merge-commit` exit 1;
`subtree merge --squash` failed without moving `HEAD`. The synthetic commit
is created through `commit-tree`, while the branch merge uses
`git merge --no-ff`; only the synthetic commit remains ungated at creation.

`git subtree split --rejoin --prefix=<prefix>` combines a ref-less split with
a merge back into the current branch. In the automatic, conflict-free path of
a Git 2.48.1 fixture with earlier add/rejoin metadata and a new subtree
change, it created split commits and a two-parent rejoin merge; the split generation fired no
commit-creation hook, while the rejoin fired `pre-merge-commit`,
`prepare-commit-msg`, `commit-msg`, `post-merge`, and `reference-transaction`,
but not `pre-commit`. Since issue #404, the wired `pre-merge-commit` gates
the rejoin merge, with same-operation tree-marker dedup in
`prepare-commit-msg`. This does not gate the generated split commits at
creation. Before issue #405, directly pushing the split tip caused the
pushed-ref mismatch; the implemented push hook now analyzes that tip at its
own commit state. With `--squash`, the command
additionally creates a ref-less synthetic squash commit before the rejoin
(评审 4117843430). The 2026-09-30 git 2.48.1 recheck distinguishes two
states: a plain directory with no prior subtree add/rejoin metadata uses
`cmd_add`, creating the initial rejoin through `commit-tree` and `reset`
without commit-creation hooks; after a squash add or an earlier squash
rejoin, new subtree content uses `cmd_merge` and fires `pre-merge-commit`,
`prepare-commit-msg`, `commit-msg`, and `post-merge` for the rejoin. Its
hook index tree equals the resulting two-parent branch merge tree. The
installed `cmd_split` selects `cmd_add` or `cmd_merge` using
`find_latest_squash`; two non-squash probes confirmed the same state
boundary: no creation hook on a plain directory's first rejoin, then the
three creation hooks on a later rejoin after new subtree content.
The earlier blanket no-hook squash measurement represented only the first
state. Generated split and synthetic squash commits remain ungated at
creation in both states; the #405 per-ref gate covers any such tip pushed.

`git subtree push --prefix=<prefix> <repository> <refspec>` also creates a
rewritten split chain, but pushes its tip directly without leaving a local
split branch. Measured on git 2.48.1 with a two-commit fixture, it created a
two-commit split history and fired no commit-creation hook or checked-out
branch ref update. `pre-push` received the split tip OID while `HEAD` remained
the different full-project commit; the push installed the split tip on the
bare remote. The local `reference-transaction` callback observed in that probe
was for `refs/remotes/origin/<refspec>` after the remote accepted the push, so
it cannot block that outbound update. Split generation bypasses the commit
gate; before issue #405, the push hook also analyzed the wrong tree. The
ordinary form has no pre-push local ref transaction that can close #404
before the split is pushed;
analyzing the pushed split tip is the #405 disposition.

`git subtree push --prefix=<prefix> --branch <branch> <repository> <refspec>`
differs: it installs the generated split tip on a local branch before
pushing. Measured on git 2.48.1, the command created `refs/heads/<branch>`
with `reference-transaction` (`prepared` and `committed`) before `pre-push`
ran (评审 4117947441). That local ref update is a #404 closure candidate —
`reference-transaction` can reject the branch creation — while the push
itself scanned the checked-out tree before issue #405. The implemented
per-ref push gate now analyzes the generated split tip at its own commit
state.

`git subtree push --rejoin --prefix=<prefix> <repository> <refspec>` is a
different path. When the subtree has new commits, `--rejoin` merges the
generated split tip back into the checked-out branch before pushing. In a
Git 2.48.1 fixture with a new subtree commit after an earlier rejoin, the
resulting two-parent merge fired `pre-merge-commit`, `prepare-commit-msg`,
`commit-msg`, `post-merge`, and `reference-transaction` for the checked-out
branch; `pre-push` then received the generated split-tip OID, not the new
rejoin `HEAD`. The Git 2.43 probe reported by review 4115812068 observed the
same key hooks. Since issue #404, the wired `pre-merge-commit` gates this
rejoin merge routed through `git merge --no-ff`, with same-operation
tree-marker dedup in `prepare-commit-msg`; generated split commits still
have no creation hook.
Before issue #405, `pre-push` scanned the rejoin working tree rather than
the pushed split tip. The implemented push hook now analyzes the split tip
at its own commit state, using the temporary-worktree path when it differs
from `HEAD`. With `--squash`, the rejoin additionally creates a ref-less
synthetic squash commit before the
merge (评审 4117872586): the synthetic commit already exists before the
branch transaction, so `reference-transaction` cannot close its creation.
The 2026-09-30 git 2.48.1 recheck of `push --rejoin --squash` confirms
the same state boundary as `split --rejoin`: the first rejoin of a plain
directory without add/rejoin metadata uses ungated `cmd_add`; after a squash
add or an earlier squash rejoin, the branch merge fires
`pre-merge-commit`, `prepare-commit-msg`, `commit-msg`, and `post-merge`.
In all three fixtures, `pre-push` receives the generated split tip, distinct
from the rejoin `HEAD`; that tip is subject to the #405 per-ref gate.

`git subtree add --prefix=<prefix> <commit>` is another distinct operation:
it installs a merge commit on the checked-out branch. In a Git 2.48.1 fixture
with diverged source and target commits, the command created a two-parent
merge commit containing the prefixed tree. The measured hooks were shared
`post-index-change` and `reference-transaction` callbacks; neither
`pre-commit` nor `pre-merge-commit` ran. This branch-history path belongs in
#404's hook-design inventory; unlike `stash create` and ordinary `subtree
push`, it updates the checked-out branch, so `reference-transaction` is a
possible closure to evaluate there. With `--squash`, the command additionally
creates a ref-less synthetic squash commit before the merge (评审 4117804224):
measured on git 2.48.1, `git subtree add --prefix=<prefix> --squash <commit>`
produced both a `Squashed '<prefix>/' content` commit and the merge commit,
with only `post-index-change` and `reference-transaction` firing. The
synthetic commit already exists before the branch transaction and can be
pushed directly by OID, so `reference-transaction` cannot close the squash
commit itself; its push-side exposure is the same #405 remedy.

`reference-transaction` does **not** close every `commit-tree` path,
though: `update-ref` is optional. A commit object can be pushed directly by
OID — `git push <remote> <oid>:refs/heads/…` — while no local ref ever
points at it, so no local `reference-transaction` fires; `pre-push` runs
but analyzes the unrelated checked-out tree (评审 4115241708). Measured on
git 2.48.1: such a push installed the object on the remote
(`refs/heads/direct`) while the local hook log shows only `pre-push`
reading the pushed OID from stdin and no `reference-transaction` entry. The
absence of that ref-update hook does not prevent `pre-push` from blocking
the operation: a separate Git 2.48.1 probe with `pre-push` exiting 1 rejected
the direct-OID push and left the remote ref absent; with exit 0 the remote
ref received the exact OID. This matches the
[documented pre-push contract](https://git-scm.com/docs/githooks#_pre_push)
(评审 4115477917). The plumbing path therefore splits: the local-ref variant is a #404
`reference-transaction` question; the direct-OID variant is a push-side gap
that only the #405 remedy (analyze the pushed ref) can close.

One qualification applies to the `git commit` rows themselves: formatting,
lint, type checks, coverage and Sonar scan the working tree, while Git records
the tree selected for that invocation. Ordinary index-based commits use the
staged contents; pathspecs
and content-selection flags can select a different tree. For an ordinary
index-based commit, working-tree state beyond the index is analyzed but not
committed. With partially staged changes — state A staged, further state B
left unstaged — `pre-commit` runs the checks against A+B and the commit
records A alone (评审 4114992019); the same holds for any untracked file,
whether or not git lists it — untracked files are absent from the index yet
still scanned by the gate, because Prettier, ESLint, and the TypeScript
compiler all read the working tree, and compiler inclusion is independent
of git's ignore rules. An untracked file excluded through `.git/info/exclude`
leaves `git status` clean apart from the staged entry, yet this repository's
`tsconfig.json` includes all of `src`, so `typecheck:strict` sees that
ignored definition (评审 4115165665) (评审 4115036983).
Measured on git 2.48.1: a `pre-commit` hook observed an unstaged definition
and, in a second run, an untracked one that the resulting commit did not
contain; a third run confirmed an ignored (`info/exclude`) file is likewise
invisible to `git status` yet visible to the hook. That state can, for example, supply a definition A depends on,
letting the gate pass while the commit alone does not build. This is the
commit-side analog of the [historical push finding](quality-gate-push.md#known-finding-push-scans-the-checked-out-tree-not-the-pushed-ref) — same root cause, the
gate scans the working tree — recorded here as a boundary rather than fixed.

Matching the original index is insufficient for path-limited commits
(评审 4115548805). With both A and B modified and staged, `git commit
--only A` and the implicit pathspec form `git commit A` record new A plus
old B, while the gate reads new A plus new B. In Git 2.48.1 isolated probes,
the working tree matched the original index before both commands, and that
index retained both staged versions afterward. `git commit --amend --only`
without paths likewise omitted the staged changes and retained the previous
tree; ordinary `git commit` and `git commit --include A` recorded both
staged versions in the same fixture. These results match Git's
[content-selection contract](https://git-scm.com/docs/git-commit#Documentation/git-commit.txt--o).
In all five cases, the effective index exposed to `pre-commit` through Git's
environment matched the resulting commit tree, but the gate's checks read
working-tree files independently of that index. An analysis of the original
index alone would therefore not close this boundary.

So the accurate statement of the invariant is:

> The gate analyzes the **working tree**; the file-size stage additionally
> checks source blobs and their bounded baseline in the effective commit index
> (issue #432,
> [File Size Guard](file-size-guard.md)). It runs on `git commit`,
> and — since the issue #405 wiring — on `git push` for every pushed ref at
> that ref's commit state: in the checked-out working tree only under the
> provable-equality preconditions, otherwise in a temporary worktree checked
> out at the pushed commit. It also runs — since the issue #404 wiring —
> on every commit-creating porcelain with a wireable pre-creation hook:
> automatic conflict-free `git merge` and `git pull` (default merge mode)
> through `pre-merge-commit`, automatic conflict-free `git revert` and
> `git cherry-pick`, every replayed `git rebase` commit (including
> conflict-resolved `git rebase --continue`), the automatic branch merges
> of `git subtree merge` / `pull` (including `--squash`) and the
> `split --rejoin` / `push --rejoin` merges (with or without `--squash`)
> routed through `git merge --no-ff` after prior add/rejoin metadata, and
> commit-side `--no-verify` on `git commit` /
> `git merge` (whose `prepare-commit-msg` still fires), all through
> `prepare-commit-msg`. The tree it passes is the tree
> actually recorded only when the analyzed contents match that tree: at
> commit time, they must match the **actual tree selected for that invocation**,
> after pathspecs and content-selection flags are applied. Matching the
> original index alone is insufficient: this excludes staged changes omitted
> by `--only` or a pathspec, unstaged tracked changes (including ones hidden
> by `skip-worktree` or `assume-unchanged`), and additional untracked or
> ignored inputs the gate reads. At push time (issue #405), the fast path
> takes the current working tree only when the pushed commit is `HEAD`, the
> index and working tree have no tracked differences from it, and no
> untracked non-ignored files exist anywhere in the repository — this is
> checked, not assumed. Ignored inputs and
> differences hidden by `skip-worktree` / `assume-unchanged` remain outside
> what git can prove (fast-path residuals recorded in
> [Push-Path Per-Ref Gating](quality-gate-push.md#push-path-per-ref-gating-issue-405)); every
> other push is analyzed in a pristine temporary worktree of the pushed
> commit, which closes both.
> For automatic, conflict-free operations, it does **not** analyze:
> `git am`, `git stash` in any entry-creating form
> (`push`, shorthand, `save`, `-u`/`--all`; entry commits under
> `refs/stash`), `git stash create` (a ref-less stash commit object),
> `--autostash` on `merge`/`pull`/`rebase` (ref-less temporary stash
> commits; the merge/rebase commits they wrap are gated),
> `git notes` mutations (commits under `refs/notes/*`),
> `git commit-tree` (commit objects placed on history via `update-ref`),
> `git hash-object -t commit -w` (commit objects written directly, then
> installed via `update-ref` or pushed by OID),
> `git replace` in any form (ordinary `[-f] <object> <replacement>`,
> `--graft`, `--edit`, `--convert-graft-file`; replacement
> commits under `refs/replace/*`),
> `git fast-import` (`commit <ref>` stream commands), `git quiltimport`
> (quilt patchset commits), `git filter-branch`
> (rewritten history), `git lfs migrate` (extension history rewrite /
> no-rewrite commit; reviewer probe, see note), `git subtree split --branch` (rewritten commits under
> the requested branch), `git subtree split` without `--branch` (a ref-less
> split commit publishable by direct-OID push), the generated
> split commits of `subtree split --rejoin` / `push` / `push --rejoin` and
> the `git subtree add` merge commit, the initial rejoin branch commit of
> `split --rejoin` / `push --rejoin` (with or without `--squash`) when no
> prior add/rejoin metadata is found, and the `--squash` variants' synthetic
> commits, at creation. The later branch merge/rejoin commits reached
> through `git merge --no-ff` are gated, as distinguished above. For both
> `subtree push` forms, `pre-push` now gates
> the generated split tip at that commit's state (issue #405); the earlier
> checked-out-tree scan is retained in the [historical push finding](quality-gate-push.md#known-finding-push-scans-the-checked-out-tree-not-the-pushed-ref). The
> `--squash` variants of `subtree add`, `merge`, `pull`, `split --rejoin`,
> and `push --rejoin` additionally create a ref-less synthetic squash commit
> that no local hook can gate. With `rebase --update-refs`, the replayed
> tips of other local branches move by `reference-transaction` alone and are
> not gated. `git push --no-verify` still bypasses the push-time
> `pre-push` rerun entirely (`git push -h` documents it as "bypass pre-push
> hook"); commit-side `--no-verify` runs the gate through the wired
> `prepare-commit-msg` since issue #404 (single-use marker; the editor-abort
> residue noted in [marker ownership](quality-gate-lifecycle.md#commit-marker-ownership-and-reuse) bounds the claim).

An earlier revision of the cost decision record claimed that no commit is ever created without
the full gate having run, and that the only shared hook for `revert` and
`cherry-pick` was `prepare-commit-msg` *and* `commit-msg`. Both claims were
false; review on PR #403 caught them. `commit-msg` never fires for those two
commands, which also means the `commit-msg`-based remedy that revision proposed
would not have closed the gap at all — see below.

Automatic conflict-free `revert` and `cherry-pick` commits have no
pre-commit-equivalent hook, and no `commit-msg` either. `prepare-commit-msg` is
their pre-creation message hook; the shared index-write callback above cannot
block the operation. The issue #404 wiring nevertheless selects
`prepare-commit-msg` as the gate point for exactly these paths: a measured
probe (git 2.48.1) confirmed its non-zero exit aborts `git revert` and
`git cherry-pick` before the commit exists, and the automated probe in
`scripts/gate-tree-marker.test.ts` pins that behavior. Because
`prepare-commit-msg` also fires for ordinary `git commit` and merge commits —
where `pre-commit` / `pre-merge-commit` have already gated the same index tree
— the tree marker (`scripts/gate-tree-marker.sh`) deduplicates: an ordinary
commit or merge still pays exactly one complete gate run, while
revert / cherry-pick / rebase replays (and `--no-verify` commits) find no
fresh matching marker and run the complete gate. The marker is consumed on a
successful check (评审 4120128545), so it serves exactly the operation that
wrote it and cannot be reused by a later same-tree operation; the fallback
gate run itself writes no marker (评审 4120239723) — two consecutive
same-tree `--no-verify` commits therefore each pay the complete gate. The earlier
record declined
to propose this remedy because closing the gaps "would change gate behavior",
which the #356 decision explicitly did not do; issue #404 is precisely the
follow-up decision that authorizes the behavior change, and this section now
records its outcome.

## Known Finding: Uncovered Commit-Creation Paths

**Update 2026-09-28 (issue #404 wiring)**: conflict-free `git merge`,
`git pull` (default merge mode), `git revert`, `git cherry-pick`, replayed
`git rebase` commits (including conflict-resolved `--continue`), the
automatic subtree merge/rejoin commits routed through `git merge --no-ff`,
and commit-side `--no-verify` are
**no longer uncovered** — they are gated through the wired
`pre-merge-commit` / `prepare-commit-msg` hooks with tree-marker dedup (see
[What The Gate Actually Enforces](#what-the-gate-actually-enforces)). The
original finding text below is retained for the paths that remain uncovered.

The uncovered automatic commit-producing paths and replacement-object paths —
`git am`,
`git commit-tree` plus `git update-ref`, `git hash-object -t commit -w`
plus `git update-ref` or direct-OID push, `git fast-import`,
`git quiltimport`, `git filter-branch`, `git lfs migrate` (extension;
reviewer probe, not measured here),
`git subtree split --branch`, `git subtree split` without `--branch` (a
ref-less split commit publishable by direct-OID push), the generated
split commits of `git subtree split --rejoin` and `git subtree push`
(with or without `--rejoin`), `git subtree add`,
`git stash create`, `--autostash` on `merge`/`pull`/`rebase` (the wrapped
merge/rebase commits are gated; the temporary stash objects are not), with
`rebase --update-refs` the replayed tips of other local branches, and
`git replace` in any form (ordinary, `--graft`, `--edit`,
`--convert-graft-file`) — can produce or replace commits without the gate
analyzing the resulting commit (评审
4115477920, 4115606416, 4115639629, 4115682292, 4115710587, 4115748220,
4115748226, 4115812068, 4115865920, 4115865924, 4117675224, 4117675234,
4117872584, 4117983619). The `--squash` variants of `subtree add`, `merge`, `pull`,
`split --rejoin`, and `push --rejoin` additionally create a ref-less
synthetic squash commit that no local hook can gate (评审 4117804224,
4117843430, 4117872586).
For `split --rejoin` / `push --rejoin`, only the initial branch commit
without prior add/rejoin metadata shares the ungated `subtree add` path;
later merge/rejoin commits are gated even with `--squash`, as recorded in
the corrected table.
`git subtree push` does run `pre-push`, which since issue #405 analyzes
the generated split tip at its own commit state. With `--rejoin`, the
generated split is also merged into the checked-out branch; after prior
add/rejoin metadata, that merge is gated by the wired `pre-merge-commit`
(issue #404), including with `--squash`, while
the generated split commits remain ungated at creation. The earlier
#405 pushed-tip mismatch is closed by the per-ref push gate. `git subtree
add` is a separate unchecked merge path with a `reference-transaction`
callback, as measured above (评审 4115748226). For
`split --rejoin`, only the rejoin merge updates the checked-out branch; in the
automatic conflict-free path after prior add/rejoin metadata, split commits
are generated without commit hooks while the rejoin is gated. Without that
metadata, the initial rejoin remains ungated at creation, regardless of
`--squash`. If the
rejoin conflicts and is continued through `git merge --continue`, `pre-commit`
runs for that merge while split generation remains ungated (评审 4115865920).
`git stash push` is not counted here because its commits stay under
`refs/stash`; `git stash create` is included because it produces a ref-less
object. The `reference-transaction` options for stash push and notes are
deliberately **not wired** by the issue #404 fix: that hook fires on every
ref update — including fetch, push remote-tracking updates, branch
create/delete, reset, and tag — so gating it with the complete gate would
tax routine non-committing ref operations, and aborting `prepared` states
can break ordinary workflows; the remote-facing exposure of stash/notes
objects is the [#405](https://github.com/hailingu/PlotWeave/issues/405)
push-side gap (push scans the checked-out tree). Revisit as an owner
decision if those paths see real use. Separately, `git push --no-verify`
bypasses the push-time `pre-push` rerun entirely (评审 4115110181,
4115477925). It does not undo an earlier `pre-commit` gate run: if the
commit was created through ordinary `git commit`, that gate already ran,
subject to the commit-tree/working-tree mismatch described above. A push with no
analysis of the pushed state is possible when no earlier gate analyzed
that state, for example after one of the uncovered creation paths. The
prohibition in `AGENTS.md` covers this push-time bypass regardless of any
earlier analysis.

Push-time analysis since the issue #405 fix (2026-09-30) covers every
pushed ref at that ref's own commit — a pristine temporary-worktree checkout
unless the current tree is provably identical to the pushed commit (see
[Push-Path Per-Ref Gating](quality-gate-push.md#push-path-per-ref-gating-issue-405)). The
pre-fix wording is retained in the [historical push finding](quality-gate-push.md#known-finding-push-scans-the-checked-out-tree-not-the-pushed-ref) as the record of what the narrow case
used to be: the fast path's residuals (tracked differences hidden by
`skip-worktree` or `assume-unchanged`, extra ignored inputs) are exactly
the parts of that wording git still cannot prove (评审 4115241706,
4115510915), and the slow path closes them.
Whether to wire `pre-merge-commit` was a governance decision with a real cost
attached (every merge became a gate run); it was out of scope for #356 and
has since been decided and implemented by
[#404](https://github.com/hailingu/PlotWeave/issues/404) (2026-09-28), which
wired `pre-merge-commit` and `prepare-commit-msg` with tree-marker dedup so
each commit-creating operation pays exactly one complete gate run.
