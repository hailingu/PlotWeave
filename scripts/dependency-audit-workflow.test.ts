/** Dependency audit failures and immutable CI tool selection are workflow data contracts. */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { expect, it } from 'vitest'

interface Step {
  uses?: string
  run?: string
  if?: unknown
  'continue-on-error'?: unknown
  with?: Record<string, unknown>
}
interface Job {
  steps: Step[]
  'continue-on-error'?: unknown
}
interface Workflow {
  jobs: Record<string, Job>
}

/** Reuse the repository's existing locked YAML parser, interpreting structure rather than source wording. */
const { load } = createRequire(import.meta.url)('js-yaml') as {
  load: (source: string) => Workflow
}
const workflow = load(
  readFileSync(
    resolve(import.meta.dirname, '../.github/workflows/ci.yml'),
    'utf8',
  ),
)

/** An unconditional step and job must propagate their real nonzero exit. */
function expectBlocking(job: Job, step: Step | undefined): void {
  expect(step).toBeDefined()
  expect(job['continue-on-error'] ?? false).toBe(false)
  expect(step?.['continue-on-error'] ?? false).toBe(false)
  expect(step?.if).toBeUndefined()
}

it('blocks frontend on the full high/critical npm audit instead of swallowing its status', () => {
  const job = workflow.jobs.frontend!
  const audits = job.steps.filter(
    (step) => step.run === 'npm audit --audit-level=high',
  )
  expect(audits).toHaveLength(1)
  expectBlocking(job, audits[0])
})

it('pins cargo-audit to a specific semantic version and audits both lockfiles without ignore flags', () => {
  const job = workflow.jobs.rust!
  const installs = job.steps.filter(
    (step) =>
      typeof step.with?.tool === 'string' &&
      step.with.tool.startsWith('cargo-audit@'),
  )
  expect(installs).toHaveLength(1)
  expect(installs[0]?.with?.tool).toMatch(/^cargo-audit@\d+\.\d+\.\d+$/)
  for (const file of ['src-tauri/Cargo.lock', 'crates/Cargo.lock']) {
    const audits = job.steps.filter(
      (step) => step.run === 'cargo audit --color never --file ' + file,
    )
    expect(audits).toHaveLength(1)
    expectBlocking(job, audits[0])
  }
})

it('pins every remote CI Action to a full commit SHA', () => {
  const actions = Object.values(workflow.jobs)
    .flatMap((job) => job.steps)
    .map((step) => step.uses)
    .filter((uses): uses is string => !!uses && !uses.startsWith('./'))
  expect(actions.length).toBeGreaterThan(5)
  for (const action of actions)
    expect(action).toMatch(/^[\w.-]+\/[\w./-]+@[a-f0-9]{40}$/)
})
