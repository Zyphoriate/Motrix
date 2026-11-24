import { useAddTaskDialogStore } from '@renderer/components/add-task-dialog/use-add-task-dialog-store'
import { invalidateTaskList } from '@renderer/hooks/use-task-list'
import { transport } from '@renderer/lib/transport'
import { Commands } from '@shared/protocol/commands'
import { Events } from '@shared/protocol/events'
import { Queries } from '@shared/protocol/queries'
import { PendingMediaSelectionSummarySchema } from '@shared/schemas/pending-media-selection'
import {
  CreatePluginMediaTasksResultSchema,
  type MediaSelectionPreview,
  MediaSelectionPreviewSchema,
  type MediaSelectionQuality,
} from '@shared/schemas/plugin-media-selection'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { usePendingMediaSelectionStore } from './store'

function hasOtherDialog() {
  return (
    useAddTaskDialogStore.getState().open ||
    document.querySelector(
      '[role="dialog"]:not([data-inspector-drawer="true"]), [role="alertdialog"]'
    ) !== null
  )
}

export function usePendingMediaSelection() {
  const { t } = useTranslation()
  const requested = usePendingMediaSelectionStore((state) => state.requestId)
  const revision = usePendingMediaSelectionStore((state) => state.revision)
  const addTaskOpen = useAddTaskDialogStore((state) => state.open)
  const [pending, setPending] = useState<string[]>([])
  const [selection, setSelection] = useState<{
    requestId: string
    preview: MediaSelectionPreview
  } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [dialogTick, setDialogTick] = useState(0)
  const shown = useRef(new Set<string>())
  const latestPending = useRef<string[] | null>(null)
  const current = useRef(selection)
  current.current = selection
  const alive = useRef(false)
  const snapshotGeneration = useRef(0)
  const previewGeneration = useRef(0)
  const creating = useRef(false)

  const dismiss = useCallback(() => {
    previewGeneration.current += 1
    setSelection(null)
    setError(null)
  }, [])

  const refresh = useCallback(async () => {
    const generation = ++snapshotGeneration.current
    try {
      const response = await transport.invoke(
        Queries.ListPendingMediaSelections
      )
      const list = PendingMediaSelectionSummarySchema.array().parse(response)
      if (!alive.current || generation !== snapshotGeneration.current) return
      const ids = list.map((item) => item.requestId)
      latestPending.current = ids
      setPending(ids)
      if (current.current && !ids.includes(current.current.requestId)) dismiss()
      return ids
    } catch {
      // Keep the last snapshot during transient disconnects; reconnect retries it.
      return undefined
    }
  }, [dismiss])

  useEffect(() => {
    alive.current = true
    const onChanged = () => {
      void refresh().then(async (ids) => {
        const active = current.current
        if (!active || creating.current || !ids?.includes(active.requestId))
          return
        const generation = ++previewGeneration.current
        try {
          const response = await transport.invoke(
            Queries.GetPendingMediaSelection,
            { requestId: active.requestId }
          )
          if (!alive.current || generation !== previewGeneration.current) return
          if (response === null) dismiss()
          else {
            const preview = MediaSelectionPreviewSchema.parse(response)
            setSelection({ requestId: active.requestId, preview })
          }
        } catch {
          void refresh()
        }
      })
    }
    transport.on(Events.PendingMediaSelectionsChanged, onChanged)
    const unsubscribe = transport.onConnectionChange?.(({ state }) => {
      if (state === 'connected') onChanged()
    })
    void refresh()
    return () => {
      alive.current = false
      snapshotGeneration.current += 1
      previewGeneration.current += 1
      transport.off(Events.PendingMediaSelectionsChanged, onChanged)
      unsubscribe?.()
    }
  }, [dismiss, refresh])

  useEffect(() => {
    let blocked = hasOtherDialog()
    const observer = new MutationObserver(() => {
      const nextBlocked = hasOtherDialog()
      if (blocked && !nextBlocked && !current.current)
        setDialogTick((tick) => tick + 1)
      blocked = nextBlocked
    })
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['role', 'data-open', 'data-closed'],
    })
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    // A portal mutation can unblock an automatic picker without changing stores.
    void dialogTick
    if (selection || addTaskOpen || hasOtherDialog()) return
    const requestId = requested ?? pending.find((id) => !shown.current.has(id))
    if (!requestId) return
    let active = true
    const generation = ++previewGeneration.current
    void transport
      .invoke(Queries.GetPendingMediaSelection, { requestId })
      .then((response) => {
        if (!active || generation !== previewGeneration.current) return
        if (hasOtherDialog()) return
        if (
          latestPending.current &&
          !latestPending.current.includes(requestId)
        ) {
          usePendingMediaSelectionStore.getState().clear(revision)
          void refresh()
          return
        }
        usePendingMediaSelectionStore.getState().clear(revision)
        shown.current.add(requestId)
        if (response === null) {
          void refresh()
          return
        }
        const preview = MediaSelectionPreviewSchema.parse(response)
        setError(null)
        setSelection({ requestId, preview })
      })
      .catch(() => {
        if (!active || generation !== previewGeneration.current) return
        shown.current.add(requestId)
        usePendingMediaSelectionStore.getState().clear(revision)
        void refresh()
      })
    return () => {
      active = false
    }
  }, [
    selection,
    addTaskOpen,
    requested,
    revision,
    pending,
    dialogTick,
    refresh,
  ])

  const submit = useCallback(
    async (entryIds: string[], quality: MediaSelectionQuality) => {
      if (!selection || creating.current || entryIds.length === 0) return
      creating.current = true
      setBusy(true)
      setError(null)
      const generation = ++previewGeneration.current
      try {
        const response = await transport.invoke(
          Commands.ConfirmPendingMediaSelection,
          { requestId: selection.requestId, entryIds, quality }
        )
        const result = CreatePluginMediaTasksResultSchema.parse(response)
        if (result.created.length > 0) invalidateTaskList()
        if (!alive.current || generation !== previewGeneration.current) return
        if (result.failed.length > 0) {
          const created = new Set(result.created.map((entry) => entry.entryId))
          setSelection({
            ...selection,
            preview: {
              ...selection.preview,
              entries: selection.preview.entries.filter(
                (entry) => !created.has(entry.id)
              ),
            },
          })
          setError(
            result.failed
              .map((failure) =>
                t('mediaSelection.entryFailed', {
                  title:
                    selection.preview.entries.find(
                      (entry) => entry.id === failure.entryId
                    )?.title ?? failure.entryId,
                  reason: failure.message,
                })
              )
              .join('\n')
          )
        } else if (result.created.length > 0) dismiss()
        else setError(t('mediaSelection.createFailed'))
      } catch (cause) {
        if (alive.current && generation === previewGeneration.current)
          setError(
            cause instanceof Error
              ? cause.message
              : t('mediaSelection.createFailed')
          )
      } finally {
        creating.current = false
        if (alive.current) {
          setBusy(false)
          void refresh()
        }
      }
    },
    [selection, dismiss, refresh, t]
  )

  return { selection, busy, error, dismiss, submit }
}
