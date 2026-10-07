import { useEffect, useRef } from 'react'
import { flushSync } from 'react-dom'
import { isSwiftHost } from '../../platform/hostEnvironment'
import {
  publishNativeProjection,
  registerNativeIntentHandler,
} from '../../platform/nativeShell'
import { useSettingsSnapshot } from '../../settings/useSettingsSnapshot'
import { listChatModels } from '../../settings/types'
import { useImageJobs } from '../imagegen/context'
import type { CanvasNode } from '../nodes/types'

/** The bridge mounts only in Swift so other hosts retain their existing snapshot lifecycle. */
export function NativeImageBridge(props: {
  readonly projectId: string
  readonly nodes: CanvasNode[]
}) {
  return isSwiftHost() ? <NativeImageSession {...props} /> : null
}

/** Image controls live in SwiftUI; scheduling, cancellation and output history keep the existing provider owner. */
function NativeImageSession({
  projectId,
  nodes,
}: {
  readonly projectId: string
  readonly nodes: CanvasNode[]
}) {
  const jobs = useImageJobs()
  const settings = useSettingsSnapshot()
  const latest = useRef({ projectId, nodes, jobs })
  latest.current = { projectId, nodes, jobs }
  useEffect(() => {
    if (!isSwiftHost()) return
    return registerNativeIntentHandler('image', (command, args) => {
      const current = latest.current
      if (
        args.projectId !== current.projectId ||
        typeof args.id !== 'string' ||
        !current.nodes.some(
          (node) => node.id === args.id && node.type === 'image',
        )
      )
        throw new Error('图片节点或所属项目已关闭。')
      if (command !== 'image.start' && command !== 'image.cancel')
        throw new Error('图片作业命令无效。')
      const id = args.id
      flushSync(() => {
        if (command === 'image.start') current.jobs.start(id)
        else current.jobs.cancel(id)
      })
      return null
    })
  }, [])
  const encoded = isSwiftHost()
    ? JSON.stringify({
        projectId,
        models: settings
          ? listChatModels(settings).map((option) => ({
              value: option.key,
              label: `${option.providerLabel} · ${option.model}`,
            }))
          : [],
        jobs: Object.fromEntries(
          nodes
            .filter((node) => node.type === 'image')
            .map((node) => [node.id, jobs.jobOf(node.id)]),
        ),
      })
    : ''
  useEffect(() => {
    if (encoded)
      publishNativeProjection('image', JSON.parse(encoded) as unknown)
  }, [encoded])
  return null
}
