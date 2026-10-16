# 门禁运行台账与证据边界

维护台账字段、物化时序、可信度限制与查询方法。本篇由[成本决策记录](quality-gate-cost.md#文档组织约定issue-472)
按 [issue #472](https://github.com/hailingu/PlotWeave/issues/472) 拆出，是该主题详细证据的唯一维护位置。
成本基线、重新评估触发条件与复测方法仍在[决策正文](quality-gate-cost.md#measured-baseline)。
沿用原记录的英文证据，保留测量日期、已实施修复与未验证边界；本次未新增行为或复测结论。

**整理日期**：2026-10-01

## Gate Run Evidence Record (issue #355)

Before issue #355, every artifact behind a passing gate conclusion —
`coverage/`, `.scannerwork/`, `src-tauri/target/` — was local-only and
gitignored, and `.github/workflows/ci.yml` deliberately does not run Sonar.
Issue #355 adopted **option A** (a versioned summary record) to retain the
executor's reported conclusions alongside Git tree identities. Hosted CI
cannot reach the local SonarQube server, so option B's artifacts would cover
only the checks it can run. Option A provides a durable self-report; it did
not close the gap in independently verifiable proof of local gate execution.

**Trust boundary (issue #431).** The JSONL ledger has no signature, hash chain,
or independently authenticated link to a scanner run. Anyone who can write
it can append or alter a format-valid success claim for an existing Git tree
without running the gate. A tree hash identifies content; even checking that
the tree object exists cannot authenticate the claimed execution, timestamp,
Quality Gate result, issue count, or coverage. Versioning preserves the claim
and its edit history, while trust still depends on the executor and the
record's provenance. A matching row must not be used as independent proof
that a gate ran or passed, or as authorization to skip the required gate.
This is the retained P3 evidence-credibility boundary from
[issue #431](https://github.com/hailingu/PlotWeave/issues/431); no authenticity
anchor or new enforcement mechanism is introduced.

**What is recorded.** After a run passes the *complete* sequence — static
checks, both coverage reports, the scanner, Quality Gate `OK`, and zero
new-code unresolved issues — `scripts/sonar-quality-gate.sh` appends exactly
one JSON line to a pending file inside `.git`
(`plotweave-gate-history.pending`), never to the tracked file mid-gate
(PR #415 评审 5338815626: a gate-side write to the tracked file leaves an
unstaged change that aborts the next rebase replay, checkout, or merge
updating that file). Since issue #548, `pre-commit` and `pre-merge-commit` run
`gate-history.sh materialize --stage-for-commit` before their gate: they
fold pending lines into the versioned ledger and `git add` it into the
commit being created, so the versioned ledger lags one commit (the
`prepare-commit-msg` fallback gate — revert, cherry-pick, rebase replays —
deliberately does not touch the ledger; see the timing property below).
Since PR #581 评审 5537970549, `pre-push` does not materialize either:
push-path records accumulate in the pending file and drain at the next
commit's fold, leaving the worktree clean after every push. Each record
line:

| Field | Meaning |
| --- | --- |
| `timestamp` | UTC ISO-8601 time of the record append, second precision. |
| `tree` | The gated **index tree** (`git write-tree`) — the same key the dedup marker uses, and the value a reader compares against `git rev-parse <commit>^{tree}` to find a success claim for that content. Matching does not authenticate the claim. |
| `head` | The commit `HEAD` pointed at during the run — the parent of the commit being created on pre-commit-style paths, the tip being pushed on `pre-push`. Provenance context, not the content-matching key; it does not authenticate execution. |
| `qualityGate` | The Quality Gate status for this run's analysis (`OK`; only fully passing runs are recorded). |
| `newCodeUnresolvedIssues` | Unresolved issue count on new code for this run (`0`; only fully passing runs are recorded). |
| `frontendLineCoveragePercent` / `rustLineCoveragePercent` | Line coverage computed from the same LCOV reports this run submitted (`DA` records with execution count > 0 count as covered). |

**Reproducible claim lookup and coverage check.** From the repository root,
run the following with the pinned Node version. Replace the argument `HEAD`
with the commit to inspect. It reads the ledger without changing it and uses
original Git objects (`GIT_NO_REPLACE_OBJECTS=1`, matching the push gate).
Malformed JSON or an unavailable target commit makes the command fail rather
than produce a success conclusion.

```sh
node --input-type=module - HEAD <<'NODE'
import { readFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';

const options = {
  encoding: 'utf8',
  env: { ...process.env, GIT_NO_REPLACE_OBJECTS: '1' },
};
const git = (...args) => execFileSync('git', args, options).trim();
const commit = git('rev-parse', '--verify', `${process.argv[2]}^{commit}`);
const tree = git('rev-parse', '--verify', `${commit}^{tree}`);
const records = readFileSync('docs/development/gate-history.jsonl', 'utf8')
  .split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line));
const successClaims = records.filter((record) =>
  record.qualityGate === 'OK' && record.newCodeUnresolvedIssues === 0);
const claimedTrees = new Set(successClaims.map((record) => record.tree));
const commitTrees = git('log', '--format=%T', 'HEAD').split('\n');
const headTrees = new Map(records.map((record) => [record.head, null]));
for (const head of headTrees.keys()) {
  const result = spawnSync('git', ['rev-parse', '--verify', `${head}^{tree}`], options);
  headTrees.set(head, result.status === 0 ? result.stdout.trim() : null);
}
const matchingSuccessClaims = successClaims.filter((record) => record.tree === tree).length;
console.log(JSON.stringify({
  commit, tree, matchingSuccessClaims,
  conclusion: matchingSuccessClaims ? 'RECORDED_CLAIM_UNAUTHENTICATED' : 'NO_RECORDED_CLAIM',
  records: records.length,
  uniqueSuccessClaimTrees: claimedTrees.size,
  commitsReachableFromHEAD: commitTrees.length,
  commitsWithMatchingClaim: commitTrees.filter((value) => claimedTrees.has(value)).length,
  recordsWithHeadTreeMismatch: records.filter((record) =>
    headTrees.get(record.head) !== null && headTrees.get(record.head) !== record.tree).length,
  recordsWithUnavailableHead: records.filter((record) => headTrees.get(record.head) === null).length,
}, null, 2));
NODE
```

- `RECORDED_CLAIM_UNAUTHENTICATED` means only that a success claim with the
  same tree exists. A manually appended format-valid row produces the same
  outcome; this recipe cannot distinguish it from a tooling-generated row.
  `NO_RECORDED_CLAIM` means no matching success claim was found, not that the
  gate failed or never ran.
- `head` is not the lookup key. On commit-creating paths the recorded `head`
  is the pre-creation HEAD, normally the parent; staged content becomes the
  new commit's tree. When that tree differs from the parent's tree,
  `git rev-parse <record.head>^{tree}` will not equal `record.tree`. An
  unchanged-tree commit can match by coincidence. On push paths, since
  issue #405, `head` is the pushed commit and its tree matches the record.
  Legacy push records can instead reflect the earlier checked-out-tree
  behavior described in the linked known finding. A head mismatch alone
  establishes neither a failed gate nor a forged record.
- The coverage counts use commits reachable from the current `HEAD`, not
  every ref in the repository. Multiple runs can claim the same tree, and
  multiple commits can share a tree; neither record count nor unique tree
  count is a count of commits independently shown to have been gated.
  The versioned ledger at `86469b8` contains 71 successful records for 34
  distinct trees, and 1,239 commits are reachable from that snapshot. These
  counts use the tracked historical input, not a current coverage guarantee;
  the command above recomputes the current snapshot. Reproduce the historical
  counts independently with:

  ```sh
  node --input-type=module <<'NODE'
  import { execFileSync } from 'node:child_process';
  const git = (...args) => execFileSync('git', ['--no-replace-objects', ...args], { encoding: 'utf8' });
  const records = git('show', '86469b8:docs/development/gate-history.jsonl')
    .split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line));
  const successClaims = records.filter((record) =>
    record.qualityGate === 'OK' && record.newCodeUnresolvedIssues === 0);
  console.log(JSON.stringify({
    successfulRecords: successClaims.length,
    uniqueSuccessClaimTrees: new Set(successClaims.map((record) => record.tree)).size,
    commitsReachableFromSnapshot: Number(git('rev-list', '--count', '86469b8')),
  }, null, 2));
  NODE
  ```

  Missing rows can reflect pre-ledger history, uncovered creation paths,
  best-effort write failures, or pending/not-yet-versioned records. Their
  presence or absence cannot establish repository-wide gate compliance.

**Deliberate properties and boundaries.**

- *Success-only tooling writes.* The gate script appends only after all
  checks pass; failed or blocked runs append nothing. This describes the
  script's behavior, not a guarantee that every ledger row came from it.
  Aborted commit operations can also leave records of successful gate runs.
  The ledger reports successes, without an exhaustive execution history or
  independently authenticated outcomes.
- *Best-effort writes, drain under the gate lock.* A pending-append failure
  (permissions, disk) prints a warning to stderr and does not block the
  already-passing gate — the same philosophy as the tree marker.
  `materialize` waits for the **same mutex the gate holds** (second-granularity
  polling of the `.sonar-gate.lock` directory) and drains
  pending → versioned while holding it: record appends happen only under
  that lock, so a concurrently passing gate cannot have its record truncated
  away in the drain window (PR #415 评审 5339243902). A lock-wait timeout —
  or a malformed timeout configuration — warns and leaves the lines pending
  for the next fold; materialize never blocks or fails the operation. If the
  append into the versioned file succeeds but the pending-file truncation
  fails, the next materialize can duplicate lines — benign under log
  semantics — and a materialize killed with SIGKILL can leave a stale lock.
  Gates do not detect or reclaim stale locks; a failed acquisition provides
  the [manual recovery instructions](quality-gate-lifecycle.md#门禁锁的人工恢复issue-430), to use only
  after confirming that no gate or materialization process is running.
  Evidence must not become a
  new way to fail a clean gate or push.
- *Materialize timing and the one-commit lag.* Gate runs write only to the
  pending file inside `.git`, so they never dirty the tracked file mid-gate
  and never interfere with subsequent Git steps. The pending file drains
  **only at commit-creation folds**: `pre-commit` and `pre-merge-commit` —
  the ordinary commit and merge paths, which reliably adopt hook staging —
  run `materialize --stage-for-commit` **before** the gate, folding the
  pending lines into the versioned file and `git add`ing the ledger into
  the commit being created. Auto-staging is attribution-guarded by the
  **exact pending bytes** (PR #581 评审 5537970549): it fires only while
  the worktree ledger is byte-exactly the index content plus the lines
  folded in this run, each parseable as JSON — the developer's staged
  selection is preserved verbatim, and any other unstaged ledger change
  (a syntactically valid manual append included; a modified/deleted
  existing line; a malformed or polluted line; a manual partial staging; an
  undecidable state with Node unavailable) warns
  `[GATE_HISTORY_UNATTRIBUTED_CHANGE]` and keeps the developer's staging
  untouched. The lines are carried by that commit, so no unstaged residue
  remains while the operation proceeds — the PR #415 breakage was an
  *unstaged* write; this path folds and stages into the same commit. The
  record for commit C's own gate run is therefore versioned in the **next**
  ordinary commit (C's tree contains the staged lines, so it cannot contain
  its own record — self-reference). The `prepare-commit-msg` fallback gate
  — automatic `git revert` / `git cherry-pick` commits and every
  `git rebase` replay — deliberately does **not** materialize: sequencer
  replays do not adopt hook-added staging, and the folded-but-uncommitted
  lines would abort the next replay (measured in this change's fixtures;
  the PR #415 protection is kept). Those runs' records stay in the pending
  file and fold with the next ordinary commit — after rebasing a branch,
  one follow-up ordinary commit (`git commit --allow-empty` qualifies, and
  lands as the exempt ledger-only tip) restores replay evidence before
  pushing. `pre-push` does not materialize (PR #581 评审 5537970549):
  push-path records drain at the next commit's fold like every other
  record, the worktree stays clean after pushes, and the fast path's
  ledger failure source documented in
  [Push-Path Per-Ref Gating](quality-gate-push.md#push-path-per-ref-gating-issue-405)
  is gone; a bare `gate-history.sh materialize` remains as a manual drain.
  A record-only commit burns a full gate run and is not the norm, except as
  an optional evidence-tip commit, which the server-side check exempts when
  it only touches the ledger. Records for
  commit-side runs of commits that are never pushed stay in the local
  pending file: nothing leaves the machine, so there is no external claim
  to verify. If the commit-time `git add` fails (best-effort), the folded
  lines stay unstaged and ride with the next change; a `rebase --abort`
  after a staged fold can discard that batch — any commit that is actually
  pushed later gets a fresh push-path record, so no durable evidence gap
  remains.
- *Working tree vs. index key.* The gate analyzes the working tree (see
  [Known Finding: Push Scans The Checked-Out Tree, Not The Pushed
  Ref](quality-gate-push.md#known-finding-push-scans-the-checked-out-tree-not-the-pushed-ref)),
  while `tree` records the index tree, matching the marker's key. With
  unstaged or untracked differences the run validated more (or different)
  content than the key identifies; the caveats of that known finding apply
  to records unchanged. The file-size checker additionally validates source
  blobs and their bounded baseline in the effective index (issue #432,
  PR #452 reviews 5374354494 / 5374500480), without allowing an indexed
  allowance to weaken the current gate's policy;
  this closes its size-policy mismatch without changing the other stages.
- *Append-only growth.* One line per fully passing run, no rotation; the
  file is a log of runs, not a derived state that can be rebuilt.
- *No secrets.* Records carry hashes, counts, and percentages only. Tokens
  never reach the record path (the gate passes them via stdin/environment
  exclusively), and raw scan artifacts stay unversioned — the issue #355
  acceptance criteria require both.

## Server-Side Evidence Verification (issue #548)

The local gate's enforcement endpoint was the machine's own Git hooks; a
`git push --no-verify` direct push, or a PR whose commits were created
without the gate, previously had no server-side backstop. Issue #548 added
two complementary backstops (方案 1 + 方案 2):

1. **CI evidence check（方案 1）.** The `gate-evidence` job in
   `.github/workflows/ci.yml` runs `scripts/verify-gate-evidence.ts` on
   every pull request targeting `dev` or `main` (`ubuntu-latest`,
   pull-request events only — push runs contain server-created merge
   commits that have no local ledger record by design). For the range
   `merge-base(base, head)..head`, against the ledger **as versioned at the
   PR head**:
   - Every commit **except the tip** must have an evidence record: a line
     whose `tree` equals the commit tree with `qualityGate == "OK"` and
     `newCodeUnresolvedIssues == 0`. A missing record fails the check
     (`[GATE_EVIDENCE_MISSING]`, exit 1).
   - The **tip** gets its own record only with the next commit (see the
     one-commit-lag property above), so a missing tip record is a warning
     (`[GATE_EVIDENCE_TIP_LAG]`, exit 0) — surfaced as a GitHub annotation.
     A tip whose only change is the ledger itself is exempt
     (`[GATE_EVIDENCE_LEDGER_ONLY_TIP]`): it carries no ungated source
     change. Merge commits never qualify for the exemption (a merge can
     carry content); as tips they get the lag warning like any other tip.
   - Malformed ledger lines are skipped and warned
     (`[GATE_EVIDENCE_MALFORMED_LINE]`), matching the ledger's log
     semantics; they do not fail the check by themselves.
   - The script always reads original Git objects
     (`GIT_NO_REPLACE_OBJECTS=1`, matching the push gate, PR #442).

   This check is why the ordinary commit paths now stage pending records
   into each commit (issue #548): with materialize-at-push only, the
   versioned ledger lags one full push cycle and every compliant PR would
   fail the per-commit requirement. With commit-time staging, a compliant
   multi-commit PR is fully evidenced except its tip. Replayed commits
   (rebase / cherry-pick / revert) are evidenced once one follow-up
   ordinary commit exists on the branch — the verifier's remediation
   message names that step (`git commit --allow-empty` then re-push); a
   rebased branch pushed without it fails the check on the replayed
   non-tip commits.

   **Release-PR integration boundary (PR #581 评审 5542207474).** A
   `dev → main` release PR's range enumerates GitHub-created merge commits
   and every integrated task branch — including each task's tip, whose
   records by the one-commit-lag design are still materializing on the
   developer's machine when the release opens. The verifier therefore
   recognizes the integration boundary instead of demanding impossible
   records: merge commits in the range are skipped (server integration
   points never ran a local gate; their content was covered by the
   constituent task PRs, which branch protection makes mandatory), the
   non-first parent of an in-range merge — an integrated branch tip — gets
   the `[GATE_EVIDENCE_INTEGRATED_TIP_LAG]` warning like a range tip, and
   commits whose tree predates the versioned ledger entirely (issue #355
   adoption) are exempted with `[GATE_EVIDENCE_PRE_LEDGER_COMMIT]`. Every
   other commit in the release range still requires evidence, so the
   tolerances do not spill over ordinary history.

2. **Branch protection（方案 2）.** GitHub branch protection is enabled on
   `dev` and `main` (owner decision, 2026-10-16): pull requests required
   (no approving-review count), the four `ci` jobs required as status
   checks, administrators included, force pushes and deletions blocked. A
   `git push --no-verify` direct push is rejected server-side before any
   code leaves the machine unverified.

**Remaining boundaries.** The trust boundary of
[issue #431](https://github.com/hailingu/PlotWeave/issues/431) is
unchanged: the ledger is unsigned, so the check raises the cost of
bypassing from "push with `--no-verify`" to "actively falsify the versioned
ledger inside a pushed commit", and does not authenticate that the gate
executed. A single-commit bypass PR surfaces only the tip warning — it is
visible at merge time but not blocking. The uncovered creation paths
(`git am`, plumbing, history rewriters) produce commits without records and
therefore fail the check once they appear as non-tip commits in a PR —
remediation is to recreate the change through the gated workflow (or let
the owner adjudicate). Rebasing a branch without a follow-up ordinary
commit fails the check on the replayed commits; the remediation is the
named `git commit --allow-empty` step, not a bypass. Path-limited commits (`git commit <pathspec>`) keep
the pre-existing working-tree-versus-index boundary recorded in
[What The Gate Actually Enforces](quality-gate-enforcement.md#what-the-gate-actually-enforces):
the record keys the effective index, which the hooks also stage the ledger
into. Commits created before the issue #548 hooks staged evidence carry no
records; they fail the check until recreated or superseded.
