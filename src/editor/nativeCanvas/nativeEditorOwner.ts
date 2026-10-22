import type { EditorController } from '../useEditorController'
import type { EditorProjectContent } from '../useEditorDocument'

/** Native actions share the current production controller and its page-lifetime admission guard. */
export interface NativeEditorActionOwner {
  project: EditorProjectContent
  editor: EditorController
  isCurrent?: () => boolean
}
