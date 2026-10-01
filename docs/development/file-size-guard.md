# File Size Guard

Issue [#432](https://github.com/hailingu/PlotWeave/issues/432), option B:
enforce file caps through a static checker. The 80-code-line executable-unit
rule remains mandatory and manually reviewed; parsing TypeScript and Rust
functions/closures is a separate follow-up, not part of this implementation.

## Contract

`npm run check:size` classifies every Git-enumerated path under `src/`,
`src-tauri/`, and `scripts/` (issue #466). A maintained source suffix —
`.ts`, `.tsx`, `.js`, `.mjs`, `.cjs`, `.css`, `.rs`, `.sh` — is measured
against its cap; new languages must extend this inventory together with
their Scope Routing row. A suffix explicitly registered in the checker's
exclusion inventory — `.png`, `.icns`, `.ico`, `.xml`, `.json`, `.toml`,
`.lock` (image/icon assets, platform manifests and policy configuration
including the guard's own baseline, lockfiles) — is not measured but is
counted in the completion record's `excluded`. Every other suffix,
including no suffix at all, fails closed with one `SIZE_UNCLASSIFIED_FILE`
diagnostic per path (a path whose bytes cannot round-trip through UTF-8 is
shown in hex); removing, renaming, or registering the path restores success.
"Not checked" is therefore always either a registered, counted exclusion or
a failing diagnostic. Generated ignored output remains outside enumeration
through Git's ignore rules.
Git supplies tracked and non-ignored untracked paths, including staged additions.
NUL-delimited Git records retain their original path bytes until maintained-source
classification. Maintained paths must round-trip through UTF-8 without replacement;
otherwise the checker fails with `SIZE_INPUT_ERROR` before filesystem lookup or
path deduplication. It does not successfully measure arbitrary non-UTF-8 filenames.
Valid Unicode paths, including a literal replacement character, remain supported;
non-source paths are excluded before the encoding validation.
The checker measures both their working-tree contents and every maintained
source blob in Git's effective index (including `GIT_INDEX_FILE` supplied by
commit hooks). Tracked files remain checked even if an ignore rule matches
them. A working-tree deletion skips only that working copy: an indexed source
remains checked until its deletion is staged. Unstaged repairs therefore
cannot hide an oversized version that the commit would retain.
For indexed source, its effective index must also authorize every legacy
allowance in `scripts/file-size-baseline.json`: an absent indexed baseline
provides no allowances; an invalid, non-regular or unmerged one fails the run.
The checker applies the stricter of the current gate's baseline and the indexed
baseline. This binds committed source to its own policy while retaining #405's
requirement that the current gate govern historical pushed trees. Staging a
policy change is not approval to add an allowance; the review requirement below
still applies.

The measurement is the number of LF bytes (`wc -l`), including blank and
comment lines; CRLF counts once, and an unterminated last line does not add
a newline. Limits are 1800 for `*.test.ts` / `*.test.tsx` and 800 otherwise,
including Rust test modules and compile-time `*.test-d.ts` probes.

`scripts/file-size-baseline.json` records grandfathered paths and their
maximum counts, never a blanket exclusion: a retained over-limit file is
reported as `SIZE_GRANDFATHERED`, and growth past its recorded maximum fails
with `SIZE_LIMIT_EXCEEDED`. Every entry — in the current gate's policy file
and in the effective index's policy — must stay anchored to a measurable
over-limit fact (issue #467): the path must exist as regular staged source
in the effective index, its measured maximum must still exceed the normal
cap, and the recorded count must equal that maximum. An entry whose path has
no indexed content (a never-committed path, a worktree-only file, or a
staged deletion) fails with `SIZE_BASELINE_STALE`, reason `unindexed`; an
entry whose measured maximum no longer exceeds the normal cap fails with
`SIZE_BASELINE_STALE`, reason `within-cap`; an entry recording a larger
count than any measured content fails with `SIZE_BASELINE_DRIFT` carrying
`count` and `measured`. Baseline findings identify the governing policy copy
with `scope: "worktree"` (current gate file) or `scope: "index"` (effective
index policy) and are reported before size diagnostics. Anchoring uses each
scope's own measured fact — the indexed content for indexed policy, the
maximum across both trees for the current policy — so unstaged
worktree-only shrinks do not invalidate an entry; a repair and its entry
update must reach the same staged change. An entry lower than measured
content produces no separate finding: the content itself fails
`SIZE_LIMIT_EXCEEDED`. A new over-limit file staged together with a
matching new entry is mechanically self-consistent and passes; that
residual is governed by the review requirement below and by the suite's
published-baseline test, which reads the versioned
`scripts/file-size-baseline.json` and validates every entry against the
real repository index (presence, exact count, over-cap). Invalid/missing
baseline data, Git enumeration failures and unreadable or non-regular
source inputs fail with
`SIZE_INPUT_ERROR`; unresolved source index stages also fail. Regular index
modes `100644` and `100755` are supported. Size diagnostics identify their
content source with `tree: "worktree"` or `tree: "index"`; the completion
record's `checked` counts distinct measured source paths rather than
content copies, and its `excluded` counts distinct registered non-source
paths across both trees. Unclassified paths are reported as
`SIZE_UNCLASSIFIED_FILE` and are never counted as checked.
Diagnostics are JSON lines; success exits 0, failures 1.
The checker never updates its baseline or source inputs automatically.
Indexed source and policy are enumerated together; deduplicated blob objects
are read with Git's batch protocol. The reader validates blob types, lengths
and byte framing before measuring content, including binary bytes and embedded
newlines. The batch buffer is sized from the object lengths rather than a new
aggregate content ceiling; this reduces subprocess overhead without skipping
source, weakening policy, or removing any complete-gate stage.

The initial baseline is empty. At rule adoption, commit
`0633f92315942aae4230d039112b7aa0c25f7077`, four source files were over limit:
`src-tauri/src/store.rs` (2448), `src/editor/EditorView.tsx` (874),
`src/model/convert.test.ts` (2761), and `src/model/convert.ts` (2255).
By local `dev` commit `09a61aa`, all four had been split below their limits
or removed; no legacy allowance needs retaining. Adding or increasing a
baseline entry requires review against the original grandfathering rule;
new violations cannot establish a new baseline.

The Rust Scope Routing command starts with `npm --prefix .. run check:size`
from `src-tauri/`, selecting the repository-root checker before Cargo checks.
Rust-only changes therefore run the guard during local path verification;
use the Node version pinned by `.nvmrc`. CI's frontend job runs the repository-wide
`npm run check:size`, including Rust source, alongside the Rust job's Cargo checks.
`scripts/check-static.sh` also runs the checker before coverage and Sonar analysis.
The shared script invokes its own checker
and baseline against the selected repository root, so the pre-push temporary
worktree path applies the current gate to the pushed tree as required by #405.
The shared entry honors `PLOTWEAVE_NODE_BIN`, defaulting to `node` when
unset or empty, just like the Sonar gate. An explicit executable is invoked
as one quoted path; its failure is propagated without trying a different
runtime (PR #452, review 5374202683).

## Key State And Invariant Matrix

Owners: `scripts/check-file-size.ts` owns size policy; `scripts/check-static.sh`
owns runtime selection; `AGENTS.md` Scope Routing owns local verification commands.
Entry points: `check:size`, the Rust local route, shared static checks,
and CI. Tests use disposable Git repositories and generated fixtures;
they do not assert line counts of versioned production files or prose.

| State / precondition | Action / transition | Observable outcome | Invariant | Verification |
| --- | --- | --- | --- | --- |
| New source / TS test file at cap | Check, append one LF, check again | Pass, then `SIZE_LIMIT_EXCEEDED` | No new file exceeds its applicable cap | CLI boundary fixtures |
| Source with spaces / newline in path, tracked or untracked | Enumerate and check | Same cap applies | File names and Git state cannot hide source | Enumeration fixtures |
| Maintained Git path contains bytes that cannot round-trip through UTF-8 | Enumerate working or effective-index paths, then repair selected index | `SIZE_INPUT_ERROR`; success only after repair | An unrepresentable source path cannot become a missing replacement path or alias another input | Raw-byte index, injected working-enumeration and selected-index recovery fixtures passed |
| Valid Unicode path, or excluded non-source path with arbitrary bytes | Check source, then exceed its cap; enumerate excluded input | Unicode source obeys its cap and exact baseline; non-source remains excluded | Encoding validation neither rejects representable source nor expands maintained-source scope | Unicode recovery/baseline and non-source fixtures passed |
| Legacy file exceeds normal cap in either tree | Keep, shrink, grow past recorded count | Report allowance for first two; reject growth | Grandfathering is bounded and visible | Working-tree and indexed baseline fixtures |
| Over-limit source | Reject, shrink to cap, re-run | Failure then success; input untouched | Rechecking observes repairs without mutating source or baseline | Recovery fixture |
| Staged source deletion / ignored build output / non-source asset | Check remaining inputs | Pass | Only maintained source participates | Scope fixtures |
| Invalid/missing baseline, invalid Git root, non-regular source | Run checker | `SIZE_INPUT_ERROR`, nonzero exit | Incomplete analysis cannot pass | Failure fixtures |
| Alternate root selected for a push gate | Run shared static script | Reject oversized working or indexed source in that root | Gate measures selected tree using current policy | Shared-entry fixtures |
| Explicit Node path with spaces; no `node` alias on PATH | Check compliant / oversized source through shared entry | Pass / `SIZE_LIMIT_EXCEEDED` | The configured runtime owns execution; default PATH is unnecessary | Runtime-selection fixtures |
| Configured runtime fails or is absent; default Node exists | Run shared entry | Propagate failure; do not fall back | A configured runtime failure cannot silently select another binary | Runtime-failure fixtures |
| Oversized source staged, then working copy shrunk or removed | Check, then restage the repair or stage the deletion | Reject indexed violation until repair/deletion reaches index | Working-tree edits cannot hide source in the selected commit tree | Partial-staging regression fixtures |
| Compliant indexed source; oversized working copy | Check, then repair working copy | Reject working copy, then pass | Both indexed and working source satisfy the same bounded policy | Two-tree fixtures |
| Git supplies an alternate effective index (`GIT_INDEX_FILE`) | Check default and selected index with the same working copy | Only the oversized selected index fails | Commit content selection, not the default index pathname, owns indexed inputs | Effective-index fixture |
| Indexed source is non-regular or has unresolved stages | Check despite a compliant regular working copy | `SIZE_INPUT_ERROR`, nonzero exit | Unsupported indexed source cannot silently pass | Index-input failure fixtures |
| Working baseline adds/increases an allowance absent or lower in effective index | Check oversized indexed source, then stage the baseline | Reject until both policies authorize the size | An unstaged policy edit cannot authorize committed source | Indexed-baseline regression and recovery fixtures |
| Alternate effective index has a different baseline | Check default and selected index | Enforce the selected baseline | Source and its committed policy use the same effective index | Selected-baseline fixture |
| Current gate policy is stricter than selected tree's baseline | Check selected source | Reject using the stricter bound | Pushes cannot weaken the current gate via historical policy | Current-policy fixture |
| Indexed baseline is malformed, non-regular, or unmerged | Repair working copy only, check again | `SIZE_INPUT_ERROR` | A working repair cannot hide invalid committed policy | Indexed-baseline failure fixtures |
| Many indexed blobs, repeated objects, binary bytes and framing-like text | Batch-read unchanged content, measure LF | Same per-path results; no extra aggregate byte ceiling | Batching changes transport cost, not source/policy semantics | Binary, duplicate and aggregate-size fixtures; CLI timing and CI |
| Indexed object is missing or is not a blob | Read batch metadata | `SIZE_INPUT_ERROR` | Incomplete object input cannot be measured as empty source | Missing/non-blob object fixtures |
| Rust-only change checked from `src-tauri/` | Run the local route; grow a Rust file past 800 LF, then repair and restage | Reject oversized working/indexed content; pass after both copies comply | Every local source route checks file caps before completion | Disposable npm-prefix Rust fixture and complete Rust route passed; see Rust Local Route Follow-up |
| Under-tree path with a registered non-source suffix (`png` `icns` `ico` `xml` `json` `toml` `lock`), tracked, untracked or index-only, possibly non-UTF-8 | Enumerate and classify | Not measured; counted in the completion record's `excluded`; run passes | An intentional exclusion is registry-bounded and observable, and classification precedes encoding validation | Exclusion-registry fixtures |
| Under-tree path with an unregistered suffix or no suffix, in the worktree or only in the effective index, possibly non-UTF-8 | Enumerate and classify | `SIZE_UNCLASSIFIED_FILE` naming the path (hex form for non-UTF-8); exit 1; removal, rename or registration restores success | No Git-enumerated maintained-scope path is silently skipped; unknown categories fail closed | Fail-closed fixtures (worktree, index-only, raw-byte) |
| Baseline entry whose path has no staged content in the effective index (nonexistent, worktree-only, or staged deletion) | Run checker, then remove the entry | `SIZE_BASELINE_STALE` reason `unindexed`; exit 1; pass after removal | An allowance requires an indexed over-limit fact; nonexistent or untracked paths cannot be pre-authorized (#467) | Issue paths (a)/(b) and staged-deletion fixtures |
| Over-limit source staged together with an entry equal to its measured maximum | Run checker | Pass with `SIZE_GRANDFATHERED` | A fact-anchored allowance is honored; adding entries remains review-governed (residual boundary) | Staged-consistency guard fixture |
| Indexed content repaired within the normal cap while its entry remains | Run checker; remove the entry in the same staged change; rerun | `SIZE_BASELINE_STALE` reason `within-cap`; pass after removal | Repairs ratchet the baseline down in the same staged change (#467) | Within-cap phase of the ratchet fixture |
| Indexed content shrunk but still over cap while the entry keeps the old maximum | Run checker; lower the entry to the measured maximum; rerun | `SIZE_BASELINE_DRIFT` with `count`/`measured`; pass after lowering | A recorded allowance equals the current measured maximum; no unbounded quota (#467) | Drift phase of the ratchet fixture |
| Worktree copy shrunk below cap while the index still holds the over-limit content | Run checker | Pass; the entry stays anchored to the indexed fact | Unstaged intermediate states do not invalidate entries (#467) | Worktree-only shrink guard fixture |
| Effective-index policy holds an entry whose indexed content is within cap | Check through a `GIT_INDEX_FILE` selected index | `SIZE_BASELINE_STALE` with `scope: "index"` | Indexed policy is anchored independently of the current gate's copy (#467) | Selected-index policy fixture |
| Published baseline gains or changes an entry | Run the script suite | Published-baseline test validates each entry against the real repository index (stage-0 regular blob, count equals LF count, over cap) | The versioned policy file is an automated checked input, not a blind spot (#467) | Published-baseline fixture |

No application/persistence contract changes. The checker is read-only and
synchronous; concurrent working-tree or index edits during a run are not a
supported snapshot guarantee. Other static checks, coverage and Sonar still
analyze working-tree contents; this change closes the size-check mismatch
only, not the broader commit-tree analysis boundary recorded in
[Gate Enforcement](quality-gate-enforcement.md#what-the-gate-actually-enforces).
Function/closure measurement remains the explicit verification gap of option B.

## Initial Verification (2026-10-01)

All matrix rows passed in the 27 fixture-based cases in
`scripts/check-file-size.test.ts`. The shared-entry regression first failed
because the old entry returned success for an 801-line new source file, then
passed after implementation. `npm run check:size` inspected 482 source files;
`npm test -- scripts` passed 119 tests and `npm test` passed 2583 tests.
Format, lint, strict type checking, build, workflow formatting and shell
syntax checks passed. The first sandboxed suite could not write the Git
index tree required by the existing gate-ledger test; the suites passed when
rerun with Git write access. Documentation received a structured review
(scope, grandfathering, diagnostics, links); no automated prose check exists.

## Runtime Selection Follow-up (Review 5374202683)

Four additional regression cases exercise the actual shared shell entry:
explicit Node with no default alias checks both compliant and oversized files;
an explicit failing or missing runtime rejects the run even when a default
Node is available. All four first failed against the literal `node` call.
The change reuses the Sonar gate's `${PLOTWEAVE_NODE_BIN:-node}` convention
and preserves shell failure propagation. The original default-runtime and
selected-root cases continue to cover the adjacent entry paths.
Verification: all 31 focused cases and all 123 script-suite tests passed;
`check:size`, shell syntax, changed-test formatting and diff checks passed.

## Indexed Content Follow-up (Review 5374354494)

The [partial-staging review](https://github.com/hailingu/PlotWeave/pull/452#discussion_r4151326413)
regression first reproduced a false pass: an 801-line
indexed source was hidden by an 800-line or deleted working copy. The checker
now enumerates the effective index with NUL-delimited Git records and reads
the indexed blob objects directly, reusing the same caps and baseline.
It preserves both the index and working tree. Restaging the repair or deletion
restores success; a compliant index cannot hide an oversized working copy.
The selected-index fixture covers the content-selection entry point used by
Git commit hooks; unsupported indexed inputs fail rather than disappear.
Verification: all 39 focused cases and 131 script-suite tests passed;
`npm run check:size` checked 482 distinct source paths across both trees.
Changed-script ESLint (zero warnings), formatting and diff checks passed.
The contract and gate-boundary documents received a structured review;
there is no configured automated prose check. All selected matrix cases
are covered; concurrent mutation and function/closure measurement retain
the limitations stated above.

## Indexed Policy And CI Follow-up (Review 5374500480)

The [indexed-policy review](https://github.com/hailingu/PlotWeave/pull/452#discussion_r4151449927)
identified an unstaged permissive baseline authorizing a staged oversized
source. Eight regression cases first passed incorrectly; they now bind the
source allowance to the effective index, reject invalid indexed policy, and
recover only after the intended baseline is staged. A stricter current gate
still limits historical or selected trees.

[CI run 36808970251](https://github.com/hailingu/PlotWeave/actions/runs/36808970251)
passed Rust but exceeded the default five-second limit of the existing
pre-commit wiring test (6.006 seconds). Each fixture gate scanned the real
repository index with one Git process per distinct blob. Batched object reads
retain the complete scan and the original test assertions/timeouts.
On the same local source tree, `time -p npm run check:size` decreased from
2.08 seconds to 0.19 seconds after batching. These are point-in-time cost
measurements, not a portable timing contract; CI supplies the runner check.
Verification: all 52 focused cases and 144 script-suite tests passed;
`check:size` checked 482 paths, and zero-warning ESLint, formatting and diff
checks passed. The existing pre-commit wiring test passed with its unchanged
assertions and five-second timeout. All selected matrix rows passed;
concurrent mutation and function/closure measurement remain the stated gaps.
The policy and gate-boundary documents received a structured review, with
no configured automated prose check.

## Rust Local Route Follow-up (Review 5374723419)

The [Rust route review](https://github.com/hailingu/PlotWeave/pull/452#discussion_r4151631059)
identified a documentation gap: the Rust-only local verification route omitted
the existing size guard. `AGENTS.md`, the README and the Rust standard now start
that route with `npm --prefix .. run check:size` from `src-tauri/`, before Cargo
formatting, linting and tests. CI already checks every Rust source through the
frontend job's repository-wide guard; the documentation makes that ownership
explicit. No checker or workflow implementation changed.

Verification: a disposable Git fixture invoked the npm-prefix command from
`src-tauri/`; 800 LF passed, 801 LF failed, an unstaged repair still rejected
the oversized indexed copy, and restaging the repair restored success.
The complete command
`npm --prefix .. run check:size && cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test`
passed on the repository (482 source paths, 594 library tests plus integration
and native probes). The first sandboxed Cargo run could not bind loopback ports;
the same command passed when local test ports were permitted.
The new matrix row passed; the earlier concurrency and executable-unit gaps
remain unchanged. The documentation received a structured review of command
directories, tool prerequisites, guard ownership and cross-references; there
is no configured automated prose check. Formatting and diff checks passed.

## Path Encoding Follow-up (Review 5375043654)

The [path-byte review](https://github.com/hailingu/PlotWeave/pull/452#discussion_r4151900880)
identified lossy decoding before working-tree lookup: a non-UTF-8 source name
could become a missing replacement path or alias compliant content. The checker
now retains each Git record byte through a reversible latin1 representation,
classifies the ASCII source suffix, and validates a lossless UTF-8 round trip
before using the maintained path. Both discovery entry points share the check.
Unsupported source names stop with the existing `SIZE_INPUT_ERROR` diagnostic;
they cannot establish a successful scan. Full byte-filename measurement is not
implemented, and excluded assets do not acquire a new encoding restriction.

The smallest real Git index fixture first returned success under the old checker
and now rejects its unrepresentable path without changing the index. Additional
fixtures cover invalid, overlong and truncated UTF-8 sequences in working/index
enumeration, selected-index recovery, Unicode names with tabs/newlines and a
literal replacement character, exact Unicode baseline binding, and excluded
non-source names. All 63 focused cases passed. The new matrix rows passed;
concurrent mutation and executable-unit measurement retain the existing gaps.

On this Darwin filesystem, creating the review's `src/bad-<0xff>.ts` filename with a literal
`0xff` byte failed with errno 92 (`Illegal byte sequence`). Raw index names use
Git's actual NUL-delimited `--index-info` protocol; working enumeration injects
that protocol into the real CLI while other Git operations use the temporary
repository. No native untracked non-UTF-8 filename reproduction is claimed on
this filesystem. The fixtures verify failure before lookup, not successful
handling of such files on another platform.
Verification: `npm run check:size && npm test -- scripts` passed (482 source paths,
155 script-suite cases); changed-script ESLint with zero warnings, formatting
and diff checks passed. Changed functions and fixture builders remain below
80 code lines. Documentation received a structured review of the encoding
contract, both discovery entry points, matrix outcomes and the filesystem gap;
no automated prose check is configured.

## Suffix Registry Follow-up (Issue #466)

Issue [#466](https://github.com/hailingu/PlotWeave/issues/466) identified
that discovery filtered enumeration through a closed suffix whitelist
narrower than the rule text: any other suffix — and any suffix-less
`scripts/` tool — was silently skipped, and the completion record offered no
signal about what had not been examined. Discovery now three-way classifies
every enumerated path in both trees: known source suffixes are measured,
registered non-source suffixes (`png` `icns` `ico` `xml` `json` `toml`
`lock`) are skipped but counted in the completion record's `excluded`, and
anything else fails closed with `SIZE_UNCLASSIFIED_FILE` naming the path
(hex form when the bytes cannot round-trip through UTF-8). The exclusion
inventory is deliberately minimal — exactly the categories present in the
tree — so introducing a new non-source category means extending the registry
in the same change; the guard's own baseline
`scripts/file-size-baseline.json` is counted as excluded policy.

Six regression cases first passed incorrectly against the old checker and
now hold: suffix-less and unknown-suffix probes fail closed in the worktree
and pass again after removal, an index-only unclassified entry fails closed,
registered exclusions pass while remaining visible in `excluded`, and a
raw-byte unclassified index name is diagnosed in hex. Baseline validation
still accepts only measured source paths. Verification: `npm run check:size`
reported `{checked: 490, excluded: 57, passed: true}` on this tree; the
focused suite passed all 69 cases in `scripts/check-file-size.test.ts` and
`npm test -- scripts` passed all 192 script-suite cases; the shared static
checks (Prettier, zero-warning ESLint, `typecheck:strict`) passed. The
482-path counts recorded in the earlier follow-up sections were correct at
their time of writing; this tree now measures 490 source paths and 57
excluded paths. Documentation changes received a structured review; no
automated prose check is configured.

## Baseline Anchoring Follow-up (Issue #467)

Issue [#467](https://github.com/hailingu/PlotWeave/issues/467) identified
that the grandfather registry had no upper bound, no staleness detection,
and no automation reading the versioned baseline: one JSON line could
authorize an arbitrarily large new file, pre-authorize a path that did not
yet exist, and entries for deleted or repaired files were never reported.
Both reproduction paths from the issue now fail closed. Every entry — in
the current gate's policy file and in the effective index's policy — must
be anchored to a measurable fact: the path exists as regular staged source
in the effective index, its measured maximum still exceeds the normal cap,
and the recorded count equals that maximum. Violations are reported as
`SIZE_BASELINE_STALE` (`unindexed` / `within-cap`) or `SIZE_BASELINE_DRIFT`
with `count` and `measured`, before size diagnostics, each with the
governing `scope`. The ratchet works in both directions: shrinking a
grandfathered file requires lowering its entry in the same staged change,
and repairing it within the cap requires removing the entry. Unstaged
worktree-only shrinks remain valid intermediate states because anchoring
follows the indexed fact. A published-baseline test now reads the versioned
`scripts/file-size-baseline.json` and validates every entry against the
real repository index, so the file is no longer an automation blind spot;
it is empty today, so that test passes trivially while still reading it.

Seven regression cases first passed incorrectly against the old checker —
the issue's paths (a) and (b), staged deletion, indexed-policy staleness,
and the drift and within-cap phases of the ratchet — while the
published-baseline and worktree-only-shrink cases are consistency guards
that cannot fail while the baseline is empty. Residual boundary, recorded:
a new over-limit file staged together with a matching new entry is
mechanically self-consistent and passes; the review requirement above
remains the control. Verification: the focused suite passed all 75 cases in
`scripts/check-file-size.test.ts` (5 red before implementation), `npm run
check:size` reported `{checked: 490, excluded: 57, passed: true}`, and
`npm test -- scripts` passed all 198 script-suite cases; Prettier,
zero-warning ESLint on the changed scripts, and `typecheck:strict` passed.
The contract and matrix above received a structured review; no automated
prose check is configured.
