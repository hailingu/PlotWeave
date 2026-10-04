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
(`plotweave-gate-history.pending`), never to the tracked file mid-operation
(PR #415 评审 5338815626: a commit-side write to the tracked file leaves an
unstaged change that aborts the next rebase replay, checkout, or merge
updating that file). After the `pre-push` gate passes, the hook runs
`scripts/gate-history.sh materialize`, which folds the pending lines into the
versioned `docs/development/gate-history.jsonl` and clears the pending file.
Each record line:

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
  for the next push; materialize never blocks or fails the push. If the
  append into the versioned file succeeds but the pending-file truncation
  fails, the next materialize can duplicate lines — benign under log
  semantics — and a materialize killed with SIGKILL can leave a stale lock.
  Gates do not detect or reclaim stale locks; a failed acquisition provides
  the [manual recovery instructions](quality-gate-lifecycle.md#门禁锁的人工恢复issue-430), to use only
  after confirming that no gate or materialization process is running.
  Evidence must not become a
  new way to fail a clean gate or push.
- *Materialize-at-push, one-commit lag.* Commit-creating paths write only to
  the pending file inside `.git`, so they never dirty the tracked file and
  never interfere with subsequent Git steps; the versioned file is touched
  only after a passing `pre-push`, at which no further tree operation is
  pending in that command. Because the evidence file must itself pass the
  gate, materialized lines are unstaged until the next commit stages them —
  stage them together with the next change; committing the file alone burns
  a full gate run on a record-only commit. Records for commit-side runs of
  commits that are never pushed stay in the local pending file: nothing
  leaves the machine, so there is no external claim to verify.
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
