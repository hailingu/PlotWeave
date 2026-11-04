// @vitest-environment happy-dom
/** Clear buttons update the real form projection independently and permit re-entry (#933). */
import { useState } from 'react'
import { afterEach, expect, it } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { NodeEditContext } from '../../nodeEdit'
import { makeNodeEditApi } from '../testScaffolding'
import { mergeNodeData } from '../patch'
import type { SceneFlowNode } from '../types'
import { SceneForm } from './SceneForm'

afterEach(cleanup)

/** This fixture applies the production merge policy to each intent instead of inspecting mocked calls. */
function Form() {
  const [node, setNode] = useState<SceneFlowNode>({
    id: 'scene',
    type: 'scene',
    position: { x: 0, y: 0 },
    data: {
      name: '天台',
      sceneNo: 7,
      episodeNo: 2,
      time: '夜',
      interior: false,
      synopsis: '雨后初晴',
      characterIds: [],
    },
  })
  const api = makeNodeEditApi({
    patchNode: (_id, command) =>
      setNode(
        (current) => mergeNodeData(current, command.patch) as SceneFlowNode,
      ),
  })
  return (
    <NodeEditContext.Provider value={api}>
      <SceneForm node={node} settings={api.settings} />
    </NodeEditContext.Provider>
  )
}

it('clearing sceneNo preserves episodeNo, renders empty, and allows a legal number again', () => {
  const view = render(<Form />)
  const clear = view.getByRole('button', { name: '清除场次' })
  expect(clear.getAttribute('title')).toBe('清除场次')
  expect(clear.getAttribute('type')).toBe('button')
  fireEvent.click(clear)
  fireEvent.blur(view.getByRole('spinbutton', { name: '场次' }))
  expect(view.getByRole('spinbutton', { name: '场次' })).toHaveProperty(
    'value',
    '',
  )
  expect(view.getByPlaceholderText('未分集')).toHaveProperty('value', '2')
  expect(view.queryByRole('button', { name: '清除场次' })).toBeNull()
  fireEvent.change(view.getByRole('spinbutton', { name: '场次' }), {
    target: { value: '8' },
  })
  expect(view.getByRole('spinbutton', { name: '场次' })).toHaveProperty(
    'value',
    '8',
  )
  expect(view.getByRole('button', { name: '清除场次' })).toBeTruthy()
})

it('clearing episodeNo preserves sceneNo and clearing both leaves both controls editable', () => {
  const view = render(<Form />)
  fireEvent.click(view.getByRole('button', { name: '移出集' }))
  expect(view.getByRole('spinbutton', { name: '场次' })).toHaveProperty(
    'value',
    '7',
  )
  expect(view.getByPlaceholderText('未分集')).toHaveProperty('value', '')
  fireEvent.click(view.getByRole('button', { name: '清除场次' }))
  expect(view.queryByRole('button', { name: '移出集' })).toBeNull()
  expect(view.queryByRole('button', { name: '清除场次' })).toBeNull()
  fireEvent.change(view.getByPlaceholderText('未分集'), {
    target: { value: '3' },
  })
  expect(view.getByPlaceholderText('未分集')).toHaveProperty('value', '3')
  expect(view.getByRole('spinbutton', { name: '场次' })).toHaveProperty(
    'value',
    '',
  )
})
