# File Size Guard

Issue [#432](https://github.com/hailingu/PlotWeave/issues/432), option B:
enforce file caps through a static checker. The 80-code-line executable-unit
rule remains mandatory and manually reviewed; parsing TypeScript and Rust
functions/closures is a separate follow-up, not part of this implementation.

## Contract

`npm run check:size` checks maintained source files under `src/`,
`src-tauri/`, and `scripts/`. Supported source suffixes are `.ts`, `.tsx`,
`.js`, `.mjs`, `.cjs`, `.css`, `.rs`, and `.sh`. New languages must extend
this inventory together with their Scope Routing row. Assets, lockfiles,
configuration and generated ignored output are not maintained source code.
Git supplies tracked and non-ignored untracked paths, including staged additions;
the checker reads their working-tree contents. Tracked files remain checked
even if an ignore rule matches them. Deleted files are skipped.

The measurement is the number of LF bytes (`wc -l`), including blank and
comment lines; CRLF counts once, and an unterminated last line does not add
a newline. Limits are 1800 for `*.test.ts` / `*.test.tsx` and 800 otherwise,
including Rust test modules and compile-time `*.test-d.ts` probes.

`scripts/file-size-baseline.json` records grandfathered paths and their
maximum counts, never a blanket exclusion: a retained over-limit file is
reported as `SIZE_GRANDFATHERED`, and growth past its recorded maximum fails
with `SIZE_LIMIT_EXCEEDED`. Invalid/missing baseline data, Git enumeration
failures and unreadable or non-regular source inputs fail with
`SIZE_INPUT_ERROR`. Diagnostics are JSON lines; success exits 0, failures 1.
The checker never updates its baseline or source inputs automatically.

The initial baseline is empty. At rule adoption, commit
`0633f92315942aae4230d039112b7aa0c25f7077`, four source files were over limit:
`src-tauri/src/store.rs` (2448), `src/editor/EditorView.tsx` (874),
`src/model/convert.test.ts` (2761), and `src/model/convert.ts` (2255).
By local `dev` commit `09a61aa`, all four had been split below their limits
or removed; no legacy allowance needs retaining. Adding or increasing a
baseline entry requires review against the original grandfathering rule;
new violations cannot establish a new baseline.

`scripts/check-static.sh` runs the checker before coverage and Sonar analysis,
and CI runs `npm run check:size`. The shared script invokes its own checker
and baseline against the selected repository root, so the pre-push temporary
worktree path applies the current gate to the pushed tree as required by #405.
The shared entry honors `PLOTWEAVE_NODE_BIN`, defaulting to `node` when
unset or empty, just like the Sonar gate. An explicit executable is invoked
as one quoted path; its failure is propagated without trying a different
runtime (PR #452, review 5374202683).

## Key State And Invariant Matrix

Owners: `scripts/check-file-size.ts` owns size policy; `scripts/check-static.sh`
owns runtime selection. Entry points: `check:size`, shared static checks,
and CI. Tests use disposable Git repositories and generated fixtures;
they do not assert line counts of versioned production files or prose.

| State / precondition | Action / transition | Observable outcome | Invariant | Verification |
| --- | --- | --- | --- | --- |
| New source / TS test file at cap | Check, append one LF, check again | Pass, then `SIZE_LIMIT_EXCEEDED` | No new file exceeds its applicable cap | CLI boundary fixtures |
| Source with spaces / newline in path, tracked or untracked | Enumerate and check | Same cap applies | File names and Git state cannot hide source | Enumeration fixtures |
| Legacy file exceeds normal cap | Keep, shrink, grow past recorded count | Report allowance for first two; reject growth | Grandfathering is bounded and visible | Baseline fixtures |
| Over-limit source | Reject, shrink to cap, re-run | Failure then success; input untouched | Rechecking observes repairs without mutating source or baseline | Recovery fixture |
| Deleted source / ignored build output / non-source asset | Check remaining inputs | Pass | Only maintained source participates | Scope fixtures |
| Invalid/missing baseline, invalid Git root, non-regular source | Run checker | `SIZE_INPUT_ERROR`, nonzero exit | Incomplete analysis cannot pass | Failure fixtures |
| Alternate root selected for a push gate | Run shared static script | Reject oversized file in that root | Gate measures selected tree using current policy | Shared-entry fixture |
| Explicit Node path with spaces; no `node` alias on PATH | Check compliant / oversized source through shared entry | Pass / `SIZE_LIMIT_EXCEEDED` | The configured runtime owns execution; default PATH is unnecessary | Runtime-selection fixtures |
| Configured runtime fails or is absent; default Node exists | Run shared entry | Propagate failure; do not fall back | A configured runtime failure cannot silently select another binary | Runtime-failure fixtures |

No application/persistence contract changes. The checker is read-only and
synchronous; concurrent edits during a run are not a supported snapshot
guarantee, matching the other working-tree static checks. Function/closure
measurement remains the explicit verification gap of option B.

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
