/** Optional scene numbering remains stable across serialization and normalization (#933). */
import { expect, it } from 'vitest'
import { parseProject, serializeProject } from './convert'
import { mkContent, NOW } from './convertFixtures'

it('an omitted sceneNo survives JSON save/reopen without repair or renumbering', () => {
  const content = mkContent()
  const scene = content.nodes.find((n) => n.type === 'scene')!
  delete scene.data.sceneNo
  const doc = JSON.parse(JSON.stringify(serializeProject(content, 'p-1', NOW)))
  const parsed = parseProject(doc)
  expect(
    parsed.content.nodes.find((n) => n.id === scene.id)?.data.sceneNo,
  ).toBeUndefined()
  expect(parsed.repaired).toBe(false)
  expect(parsed.warnings).toEqual([])
  expect(serializeProject(parsed.content, 'p-1', NOW)).toEqual(doc)
})

it.each([null, 0, -1, 1.5, '7', Number.MAX_SAFE_INTEGER + 1])(
  'invalid present sceneNo %s retains the existing repair policy',
  (value) => {
    const doc = serializeProject(mkContent(), 'p-1', NOW)
    const scene = doc.graph.nodes.find((n) => n.type === 'scene')!
    Object.assign(scene.data.spec, { sceneNo: value })
    const parsed = parseProject(doc)
    expect(
      parsed.content.nodes.find((n) => n.id === scene.id)?.data.sceneNo,
    ).toBe(1)
    expect(parsed.repaired).toBe(true)
    expect(parsed.warnings.some((w) => w.includes('sceneNo'))).toBe(true)
  },
)

it('a clear patch removes sceneNo from the serializer object before any native bridge sees it', () => {
  const content = mkContent()
  const scene = content.nodes.find((n) => n.type === 'scene')!
  Object.assign(scene.data, { sceneNo: undefined })
  const document = serializeProject(content, 'p-1', NOW)
  const stored = document.graph.nodes.find((n) => n.id === scene.id)!
  expect(
    Object.prototype.hasOwnProperty.call(stored.data.spec, 'sceneNo'),
  ).toBe(false)
})
