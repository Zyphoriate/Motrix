import { FileList } from '@renderer/components/file-list/file-list'
import { Button } from '@renderer/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@renderer/components/ui/select'
import type {
  MediaSelectionPreview,
  MediaSelectionQuality,
} from '@shared/schemas/plugin-media-selection'
import type { BaseFileRow } from '@shared/types/file-row'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

interface MediaEntryRow extends BaseFileRow {
  id: string
  durationSeconds?: number
  partNumber?: number
}

type MediaSelectionChoice = MediaSelectionQuality

export function MediaSelectionDialog({
  preview,
  busy,
  error,
  onCancel,
  onSubmit,
}: {
  preview: MediaSelectionPreview
  busy: boolean
  error: string | null
  onCancel: () => void
  onSubmit: (entryIds: string[], quality: MediaSelectionQuality) => void
}) {
  const { t } = useTranslation()
  const [selected, setSelected] = useState(
    () => new Set(preview.entries.map((entry) => entry.id))
  )
  const [quality, setQuality] = useState<MediaSelectionChoice>(
    preview.defaultQuality
  )
  const rows: MediaEntryRow[] = preview.entries.map((entry, index) => ({
    index,
    id: entry.id,
    path:
      entry.partNumber !== undefined
        ? `${t('mediaSelection.part', { number: entry.partNumber })} ${entry.title}`
        : entry.title,
    size: entry.durationSeconds ?? 0,
    ...(entry.durationSeconds !== undefined
      ? { durationSeconds: entry.durationSeconds }
      : {}),
    ...(entry.partNumber !== undefined ? { partNumber: entry.partNumber } : {}),
  }))
  const selectedRows = rows.filter((row) => selected.has(row.id))
  const entryIds = selectedRows.map((row) => row.id)
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onCancel()
      }}
    >
      <DialogContent
        showCloseButton={false}
        className="flex max-h-[85svh] flex-col gap-2 sm:max-w-2xl"
      >
        <DialogHeader>
          <DialogTitle>{t('mediaSelection.title')}</DialogTitle>
          <DialogDescription className="break-words">
            {preview.title}
          </DialogDescription>
        </DialogHeader>
        <div className="flex shrink-0 items-center justify-between gap-3">
          <span id="media-selection-quality">
            {t('mediaSelection.quality')}
          </span>
          <Select
            value={quality}
            onValueChange={(value) => {
              if (
                value !== null &&
                (preview.qualities as readonly string[]).includes(value)
              )
                setQuality(value as MediaSelectionChoice)
            }}
            disabled={busy}
          >
            <SelectTrigger size="sm" aria-labelledby="media-selection-quality">
              <SelectValue>
                {quality === 'highest'
                  ? t('settings.bittorrent.peers.mediaSelectionHighest')
                  : quality}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {preview.qualities.map((value) => (
                <SelectItem key={value} value={value}>
                  {value === 'highest'
                    ? t('settings.bittorrent.peers.mediaSelectionHighest')
                    : value}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex min-h-40 max-h-[55svh] min-w-0 flex-1 overflow-hidden rounded-md border border-border **:data-[slot=scroll-area-viewport]:focus-visible:ring-0">
          {preview.entries.length === 0 ? (
            <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
              {t('mediaSelection.selected', { selected: 0, total: 0 })}
            </div>
          ) : (
            <FileList<MediaEntryRow>
              scrollbar="custom"
              showColumnHeaders={false}
              files={rows}
              selectedIndices={selectedRows.map((row) => row.index)}
              onSelectionChange={(indices) =>
                setSelected(
                  new Set(indices.map((index) => rows[index]?.id ?? ''))
                )
              }
              summary={
                <span role="status" className="truncate text-muted-foreground">
                  {t('mediaSelection.selected', {
                    selected: entryIds.length,
                    total: rows.length,
                  })}
                </span>
              }
              renderRowSize={(row) => (
                <span className="text-xs tabular-nums text-muted-foreground">
                  {row.durationSeconds !== undefined
                    ? formatDuration(row.durationSeconds)
                    : '—'}
                </span>
              )}
              className="min-w-0 flex-1"
            />
          )}
        </div>
        {error && (
          <p
            role="alert"
            className="whitespace-pre-wrap break-words text-sm text-destructive"
          >
            {error}
          </p>
        )}
        <DialogFooter>
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={onCancel}
          >
            {t('common.cancel')}
          </Button>
          <Button
            size="sm"
            disabled={busy || entryIds.length === 0}
            onClick={() => onSubmit(entryIds, quality)}
          >
            {t('mediaSelection.download')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function formatDuration(seconds: number): string {
  const whole = Math.floor(seconds)
  const hours = Math.floor(whole / 3600)
  const minutes = Math.floor((whole % 3600) / 60)
  const remainder = String(whole % 60).padStart(2, '0')
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${remainder}`
    : `${minutes}:${remainder}`
}
