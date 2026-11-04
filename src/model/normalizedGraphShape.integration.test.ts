/** The final load boundary must catch a normalization regression before it reaches session data (#946). */
import { afterEach, expect, it, vi } from 'vitest'
import { mkContent, NOW } from './convertFixtures'

afterEach(() => {
  vi.doUnmock('./normalizeContainers')
  vi.resetModules()
})

it('rejects a required field missed by a relaxed normalization predicate with a stable diagnostic', async () => {
  const { serializeProject } = await import('./convert')
  const document = serializeProject(mkContent(), 'p-1', NOW)
  vi.resetModules()
  vi.doMock('./normalizeContainers', async (importOriginal) => {
    const actual =
      await importOriginal<typeof import('./normalizeContainers')>()
    return {
      ...actual,
      normalizeContainers(
        ...args: Parameters<typeof actual.normalizeContainers>
      ) {
        const normalized = actual.normalizeContainers(...args)
        const beat = normalized.doc.graph.nodes.find(
          (node) => node.type === 'beat',
        )
        if (!beat) throw new Error('Expected the owned beat fixture')
        // Simulate a later predicate regression, rather than claiming an independent product reproduction.
        const spec = beat.data.spec as unknown as Record<string, unknown>
        spec.tone = { missedByPredicate: true }
        return normalized
      },
    }
  })
  const { parseProject } = await import('./convert')
  expect(() => parseProject(document)).toThrow(
    '[NORMALIZED_GRAPH_SHAPE_INVALID] node b1',
  )
})
