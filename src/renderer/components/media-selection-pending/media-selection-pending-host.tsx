import { MediaSelectionDialog } from '@renderer/components/add-task/media-selection-dialog'
import { useAddTaskDialogStore } from '@renderer/components/add-task-dialog/use-add-task-dialog-store'
import { usePendingMediaSelection } from './use-pending-media-selection'

export function MediaSelectionPendingHost() {
  const { selection, busy, error, dismiss, submit } = usePendingMediaSelection()
  const addTaskOpen = useAddTaskDialogStore((state) => state.open)
  if (!selection || addTaskOpen) return null
  return (
    <MediaSelectionDialog
      key={`${selection.requestId}:${selection.preview.entries.map((entry) => entry.id).join(',')}`}
      preview={selection.preview}
      busy={busy}
      error={error}
      onCancel={dismiss}
      onSubmit={(entryIds, quality) => void submit(entryIds, quality)}
    />
  )
}
