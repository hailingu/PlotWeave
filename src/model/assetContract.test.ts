/** Issues #649/#650: active asset normalization consumes the same wire-data corpus as both hosts. */
import { describe, expect, it } from 'vitest'
import vectors from '../../crates/plotweave-core/testdata/asset-contract.json'
import { parseProject, serializeProject } from './convert'
import { mkContent, NOW } from './convertFixtures'

/** Only the path varies; every other AssetRef field is already canonical. */
const asset = (id: string, relPath: string) => ({
  id,
  relPath,
  mime: 'image/png',
  source: 'upload' as const,
  createdAt: '2026-08-01T00:00:00.000Z',
})

describe('active asset disk contract', () => {
  it.each(vectors.relPaths)(
    '$id has the shared active-index verdict',
    ({ input, active }) => {
      const doc = serializeProject(mkContent(), 'p-1', NOW)
      doc.assets.byId['candidate'] = asset('candidate', input)
      const loaded = parseProject(doc)
      expect(loaded.content.assets?.byId['candidate'] !== undefined).toBe(
        active,
      )
      if (!active) expect(loaded.warnings.length).toBeGreaterThan(0)
    },
  )

  it('isolates reserved refs while retaining real active references for the next save', () => {
    const doc = serializeProject(mkContent(), 'p-1', NOW)
    doc.assets.byId = {
      held: asset('held', 'assets/.trash/held.png'),
      missing: asset('missing', 'assets/.trash/missing.png'),
      ok: asset('ok', 'assets/ok.png'),
    }
    const loaded = parseProject(doc, { invalidAssetKeys: ['held', 'missing'] })
    const repaired = serializeProject(loaded.content, 'p-1', NOW)
    expect(repaired.assets.byId).toEqual({ ok: asset('ok', 'assets/ok.png') })
    expect(repaired.graph).toEqual(doc.graph)
    expect(parseProject(repaired).warnings).toEqual([])
  })
})
