# Quality Gate Cost Decision

**Applies to**: the versioned local Git hooks (`.githooks/pre-commit`,
`.githooks/pre-push`) and `scripts/sonar-quality-gate.sh`. Like the root
`AGENTS.md` and the other standards under `docs/development/`, this file is
written in English for agent interoperability.

**Last reviewed**: 2026-09-27

**Status**: Active — accepted decision. Recorded 2026-09-27, resolving
[issue #356](https://github.com/hailingu/PlotWeave/issues/356).

## Required Reading

- [AGENTS.md](../../AGENTS.md) — the Non-Negotiable Gates and
  Version-Control Safety sections. This file records *one* decision about that
  gate; it never relaxes it.
- [Software Engineering Standard](software-engineering-standard.md) — the
  repository-wide baseline for change design and documented exceptions.

## Decision

**The gate stays a single, uniform cost. There is no fast lane.**

Every commit and every push runs the same complete sequence:

1. `scripts/check-static.sh` — Prettier format check, ESLint with zero
   warnings, `typecheck:strict`. Fail-fast, ahead of all coverage work.
2. `npm run test:coverage` — the full frontend suite, serialized to LCOV.
3. `scripts/rust-coverage.sh` — `cargo-llvm-cov` over the library and the
   `media_format_leaf` test target.
4. `sonar-scanner` publishing the analysis, then waiting for the Quality Gate,
   then a separate check that new-code unresolved issues are zero.

This is option C of issue #356. The issue did not argue for lower quality
requirements; it argued that the "cost tier" question deserved one explicit
decision and a recorded baseline. Both now exist.

## Status Of The Alternatives

Options A and B were evaluated against the measurement below and are recorded
here as **considered and declined**, not as pending work.

| Option | Change | Measured upside | Why declined |
| --- | --- | ---: | --- |
| A | Make Rust coverage reuse build artifacts | ≤16.6s per run (23% of one gate run) | The cost has no single hotspot — the four phases are near-evenly split, so the best-case saving is bounded and small relative to the risk of changing `cargo-llvm-cov` report semantics. |
| B | Tier the check set between pre-commit and pre-push | **58.5s per commit** (80% of the pre-commit phase) | The largest lever by a wide margin, and a governance change rather than an optimization: it decides *when* checks run, and leaves an interval in which a commit exists locally without SonarQube having run. The uniform gate was judged worth that cost. |
| C | Accept the cost, record the decision and a baseline | none (by design) | Adopted. |

### What option B would actually mean

B is only coherent in one variant that preserves the "Sonar runs on the push
path" invariant, and the upside depends entirely on reading that variant
correctly. The stage allocation is:

- **before** — pre-commit runs the complete gate (72.9s), pre-push runs the
  complete gate (72.9s): 145.8s per commit-and-push cycle;
- **after (option B)** — pre-commit runs `scripts/check-static.sh` only
  (14.4s), pre-push runs the complete gate unchanged (72.9s): 87.3s per cycle.

The saving is therefore **72.9 − 14.4 = 58.5s per commit**, not 14.4s. The
14.4s figure is the *remaining* pre-commit cost after the split, and quoting it
as the saving understates option B by roughly a factor of four. At the
~30 commits/day below that is about 29 minutes per day, a ~40% reduction in
total gate time.

A review of this record caught exactly that mislabelling; the figure above is
the corrected one. Note that option B would *not* weaken the gate's coverage —
`check-static.sh` still runs on every commit, and SonarQube analysis plus the
Quality Gate still run before anything reaches the remote. What it changes is
the guarantee that no commit is ever created without the full gate having run.

Declining A and B is a statement about today's numbers, not a permanent
refusal. See [Reconsideration Triggers](#reconsideration-triggers).

## Impact On Gate Strength

**None. This decision changes no gate behavior at all.** It is a documentation
and measurement change only. The following remain in force exactly as written in
`AGENTS.md`, and nothing in this file is an exception to them:

- Both hooks stay enabled and both run the complete `sonar-quality-gate.sh`.
- `--no-verify` remains prohibited, and `core.hooksPath` remains pointed at the
  versioned `.githooks/` directory.
- No new skip, allowlist, or "fast" path is introduced. There is no environment
  variable, flag, or branch condition that reduces the check set.
- SonarQube analysis and the Quality Gate still execute on the push path.
- A failed or unavailable gate still blocks the Git operation.
- The New Code period incremental zeroing rule is unchanged: new-code unresolved
  issues must be zero, while historical issues on overall code stay triaged
  separately.

Anyone reading a faster local workflow elsewhere in this repository should treat
it as a defect in that workflow, not as sanctioned by this decision.

## Measured Baseline

Taken **2026-09-27** at commit `ba151ce` on `dev`, immediately after the
issue #363 merge, with warm build caches.

**Command** (run from the repository root `/Users/guhailin/Git/PlotWeave`):

```sh
/usr/bin/time -p sh scripts/sonar-quality-gate.sh
```

**Result**: exit 0 — `Quality Gate 已通过，新增代码未解决问题为 0`.

| Measurement | Value |
| --- | ---: |
| Wall clock, complete gate | **72.87s** |
| User CPU | 157.20s |
| System CPU | 22.64s |

### Per-phase breakdown

Measured in the same working tree and environment, by timing each stage the
gate script runs in order.

| Phase | Wall clock | Share |
| --- | ---: | ---: |
| `scripts/check-static.sh` (format + lint + `typecheck:strict`) | 14.4s | 20% |
| `npm run test:coverage` (163 files / 2478 tests) | 15.8s | 22% |
| `scripts/rust-coverage.sh` (`cargo-llvm-cov`) | 16.6s | 23% |
| `sonar-scanner` + Quality Gate wait | ~26.1s | 35% |
| **Total** | **~72.9s** | **100%** |

The scanner figure is the remainder of the measured total after the three timed
stages, and is consistent with the scanner's own reported `Analysis total time:
24.919s` plus start-up.

**The distribution is the finding that matters here.** No single phase
dominates; the four are near-evenly split between 14s and 26s. Any proposal to
cut total cost has to address more than one phase, which is why option A alone
is bounded at 23%.

### Commit frequency context

The repository has 1120 commits spanning 2026-08-21 to 2026-09-27 — 37 days at
roughly 30 commits per day. At 72.87s per run, the pre-commit hook alone costs
about 36 minutes per day. If each of those commits is also pushed, the
pre-commit and pre-push runs together cost roughly 73 minutes per day. Under
option B that total would fall to about 44 minutes per day. Treat these as
order-of-magnitude context, not measured figures — actual push frequency varies
with batching.

### Environment

| Component | Version |
| --- | --- |
| OS | macOS 26.6.2 (arm64), 16 cores / 64 GiB |
| Node.js | **v22.11.0** (see caveats) |
| npm | 10.9.0 |
| rustc | 1.95.0 (`59807616e`, pinned by `rust-toolchain.toml`) |
| `cargo-llvm-cov` | 0.9.0 |
| `sonar-scanner` CLI | 7.3.0.5189 |
| SonarQube server | 26.8.0.126808 |

### Caveats On This Baseline

Read these before comparing any future measurement against 72.87s.

1. **Warm caches.** `src-tauri/target/` and the vitest cache were already
   populated, so the Rust compile and test phases are at their incremental
   cost. A cold `target/` would be materially slower. 72.87s is therefore the
   *typical repeated* cost, not a worst case.
2. **Node version does not match the pin.** `.nvmrc` and `package.json`
   `engines` require Node >= 24.18.0, but the measuring shell ran Node
   v22.11.0. The `engines` field is advisory and nothing enforces it, so the
   gate passed on an unsupported Node. Two consequences: the absolute number is
   not exactly what a correctly-provisioned environment would produce, and the
   absence of enforcement is itself a finding. This is out of scope for #356 and
   is not fixed by it — raise it separately if the drift is unintended.
3. **Single sample, not a distribution.** One run per phase. A future comparison
   should take at least three runs and compare medians; do not treat a single
   sub-second difference as signal.
4. **Machine-local.** Absolute seconds do not transfer between machines. Compare
   ratios and per-phase shares, not the total.

## Reconsideration Triggers

Revisit this decision — and re-measure before drawing conclusions — when any of
these becomes true:

- A phase's share stops being evenly split. If one phase grows past roughly 40%
  of the total, that phase becomes the thing to optimize, and option A (or an
  equivalent) deserves a real design.
- The commit rate rises materially above the ~30/day this baseline assumes, or
  the gate is reported as a recurring source of blocked or abandoned work. The
  argument for accepting a fixed cost weakens with frequency. Because option B
  removes the coverage and scanner phases from the per-commit path, it scales
  with commit count in a way option A does not — a rising commit rate is the
  strongest argument for reopening B.
- CI gains the ability to run SonarQube, which would move the cost off the
  local critical path entirely. That changes the premise — the issue notes the
  cost cannot be unloaded to CI today precisely because CI does not carry Sonar.
- Any option A or B proposal appears: it must come with a fresh baseline and an
  explicit statement of its effect on gate strength, and must preserve every
  invariant in the section above.

## How To Re-measure

Run from the repository root with `SONAR_HOST_URL` set and a token available as
`SONAR_TOKEN` or `PLOTWEAVE_SONAR_TOKEN`:

```sh
/usr/bin/time -p sh scripts/sonar-quality-gate.sh
```

For the per-phase split, time the three non-scanner stages individually in the
order the gate script runs them, and take the remainder as the scanner phase:

```sh
time sh scripts/check-static.sh
time npm run test:coverage
time sh scripts/rust-coverage.sh
```

Record the commit under measurement and the environment table above alongside
the result, so two measurements stay comparable.
