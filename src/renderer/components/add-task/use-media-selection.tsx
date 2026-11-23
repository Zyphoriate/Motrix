import { invalidateTaskList } from '@renderer/hooks/use-task-list'
import { transport } from '@renderer/lib/transport'
import { usePlatformServices } from '@renderer/platform/services'
import { Commands } from '@shared/protocol/commands'
import { Queries } from '@shared/protocol/queries'
import type {
  AddTaskFormValues,
  TaskCreateRequest,
} from '@shared/schemas/add-task'
import {
  CreatePluginMediaTasksResultSchema,
  type MediaSelectionPreview,
  MediaSelectionPreviewSchema,
  type MediaSelectionQuality,
} from '@shared/schemas/plugin-media-selection'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { UseFormReturn } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { MediaSelectionDialog } from './media-selection-dialog'
import { taskCreateFailureReason } from './task-create-failure'

function highestQuality(
  qualities: readonly MediaSelectionQuality[]
): MediaSelectionQuality {
  return (
    [...qualities].sort((a, b) => qualityRank(b) - qualityRank(a))[0] ?? '480p'
  )
}

function qualityRank(quality: MediaSelectionQuality): number {
  return Number.parseInt(quality, 10)
}

export function useMediaSelection(
  form: UseFormReturn<AddTaskFormValues>,
  active: boolean,
  onSuccess: (taskId: string) => Promise<void>
) {
  const { t } = useTranslation()
  const platform = usePlatformServices()
  const [selection, setSelection] = useState<{
    preview: MediaSelectionPreview
    values: AddTaskFormValues
  } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const generation = useRef(0)
  const creating = useRef(false)
  const activeRef = useRef(active)
  activeRef.current = active

  const cancel = useCallback(() => {
    generation.current += 1
    setSelection(null)
    setError(null)
  }, [])

  useEffect(() => {
    if (!active) cancel()
  }, [active, cancel])
  useEffect(() => {
    const subscription = form.watch(() => cancel())
    return () => {
      subscription.unsubscribe()
      generation.current += 1
    }
  }, [form, cancel])

  const submitSingle = useCallback(
    async (
      preview: MediaSelectionPreview,
      values: AddTaskFormValues,
      quality: MediaSelectionQuality,
      current: number
    ) => {
      const entryId = preview.entries[0]?.id
      if (!entryId) return
      creating.current = true
      setBusy(true)
      try {
        const response = await transport.invoke(
          Commands.CreatePluginMediaTasks,
          {
            selectionId: preview.selectionId,
            entryIds: [entryId],
            quality,
            saveDir: values.saveDir,
            ...(values.tab === 'links' && values.split !== undefined
              ? { connections: values.split }
              : {}),
          }
        )
        const result = CreatePluginMediaTasksResultSchema.parse(response)
        if (!activeRef.current || current !== generation.current) return
        if (result.failed.length > 0 || result.created.length === 0)
          throw new Error(
            result.failed[0]?.message ?? t('mediaSelection.createFailed')
          )
        invalidateTaskList()
        cancel()
        if (values.tab === 'links' && form.getValues('urls') === values.urls)
          form.setValue('urls', '', {
            shouldDirty: true,
            shouldValidate: false,
          })
        platform.notify('info', 'task.add.batchCreated', { count: 1 })
        await onSuccess(result.created[0]!.taskId)
      } catch (cause) {
        if (activeRef.current && current === generation.current)
          platform.notify('error', 'mediaSelection.createFailed')
      } finally {
        creating.current = false
        setBusy(false)
      }
    },
    [cancel, form, onSuccess, platform, t]
  )

  const inspect = useCallback(
    async (values: AddTaskFormValues, requests: TaskCreateRequest[]) => {
      const request = requests[0]
      if (
        values.tab !== 'links' ||
        requests.length !== 1 ||
        request?.type !== 'http' ||
        request.uris.length !== 1 ||
        !/^https?:\/\//i.test(request.uris[0]) ||
        values.urls.trim().split('\n').length !== 1
      )
        return false
      const current = ++generation.current
      try {
        const response = await transport.invoke(Commands.InspectPluginMedia, {
          url: request.uris[0],
        })
        if (!activeRef.current || current !== generation.current) return true
        if (response === null) return false
        const parsed = MediaSelectionPreviewSchema.safeParse(response)
        if (!parsed.success) throw new Error(t('mediaSelection.inspectFailed'))
        const preview = parsed.data
        const settings = (await transport.invoke(Queries.GetSettings)) as {
          app?: { mediaSelectionSkipSingleDialog?: boolean }
        }
        const highest = highestQuality(preview.qualities)
        if (
          preview.entries.length === 1 &&
          settings.app?.mediaSelectionSkipSingleDialog !== false
        ) {
          await submitSingle(preview, values, highest, current)
          return true
        }
        setError(null)
        setSelection({ preview, values })
      } catch (cause) {
        if (!activeRef.current || current !== generation.current) return true
        const message =
          taskCreateFailureReason(cause) ?? t('mediaSelection.inspectFailed')
        form.setError('urls', { type: 'submission', message })
        platform.notify('error', 'mediaSelection.inspectFailed')
      }
      return true
    },
    [form, platform, submitSingle, t]
  )

  const submit = useCallback(
    async (entryIds: string[], quality: MediaSelectionQuality) => {
      if (
        !selection ||
        !activeRef.current ||
        creating.current ||
        entryIds.length === 0
      )
        return
      creating.current = true
      setBusy(true)
      setError(null)
      const current = generation.current
      try {
        const result: {
          created: Array<{ entryId: string; taskId: string }>
          failed: Array<{ entryId: string; message: string }>
        } = { created: [], failed: [] }
        // Resolve one selected part per request so large lists do not exceed
        // NAS reverse-proxy timeouts. The receipt keeps retries idempotent.
        for (const entryId of entryIds) {
          if (!activeRef.current || current !== generation.current) break
          try {
            const response = await transport.invoke(
              Commands.CreatePluginMediaTasks,
              {
                selectionId: selection.preview.selectionId,
                entryIds: [entryId],
                quality,
                saveDir: selection.values.saveDir,
                ...(selection.values.tab === 'links' &&
                selection.values.split !== undefined
                  ? { connections: selection.values.split }
                  : {}),
              }
            )
            const parsed =
              CreatePluginMediaTasksResultSchema.safeParse(response)
            if (!parsed.success)
              throw new Error(t('mediaSelection.createFailed'))
            result.created.push(...parsed.data.created)
            result.failed.push(...parsed.data.failed)
          } catch (cause) {
            result.failed.push({
              entryId,
              message:
                taskCreateFailureReason(cause) ??
                t('mediaSelection.createFailed'),
            })
          }
        }
        if (result.created.length > 0) invalidateTaskList()
        if (!activeRef.current || current !== generation.current) return
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
              .map((failure) => {
                const entry = selection.preview.entries.find(
                  (item) => item.id === failure.entryId
                )
                return t('mediaSelection.entryFailed', {
                  title: entry?.title ?? failure.entryId,
                  reason: failure.message,
                })
              })
              .join('\n')
          )
          return
        }
        if (result.created.length > 0) {
          cancel()
          if (
            selection.values.tab === 'links' &&
            form.getValues('urls') === selection.values.urls
          )
            form.setValue('urls', '', {
              shouldDirty: true,
              shouldValidate: false,
            })
          platform.notify('info', 'task.add.batchCreated', {
            count: result.created.length,
          })
          await onSuccess(result.created[0].taskId)
        } else {
          setError(t('mediaSelection.createFailed'))
        }
      } catch (cause) {
        if (activeRef.current && current === generation.current)
          setError(
            taskCreateFailureReason(cause) ?? t('mediaSelection.createFailed')
          )
      } finally {
        creating.current = false
        setBusy(false)
      }
    },
    [cancel, form, onSuccess, platform, selection, t]
  )

  return {
    inspect,
    open: selection !== null,
    busy,
    dialog: selection && (
      <MediaSelectionDialog
        key={selection.preview.selectionId}
        preview={selection.preview}
        busy={busy}
        error={error}
        onCancel={cancel}
        onSubmit={(ids, quality) => void submit(ids, quality)}
      />
    ),
  }
}
