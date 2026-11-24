import { z } from 'zod'
import type { DownloadTask } from '../types/task'
import {
  CreatePluginMediaTasksRequestSchema,
  InspectPluginMediaRequestSchema,
  MediaSelectionPreviewSchema,
  MediaSelectionQualitySchema,
} from './plugin-media-selection'

export const EnqueuePendingMediaSelectionSchema = z.object({
  ...InspectPluginMediaRequestSchema.shape,
  saveDir: z.string().min(1).max(4096),
  connections: z.number().int().min(1).max(128).optional(),
  quality: MediaSelectionQualitySchema.optional(),
  dedupKey: z.string().min(1).max(512).optional(),
})
export type EnqueuePendingMediaSelection = z.infer<
  typeof EnqueuePendingMediaSelectionSchema
>
export const ConfirmPendingMediaSelectionSchema =
  CreatePluginMediaTasksRequestSchema.pick({
    entryIds: true,
    quality: true,
  }).extend({ requestId: z.string().uuid() })
export type ConfirmPendingMediaSelection = z.infer<
  typeof ConfirmPendingMediaSelectionSchema
>
export const PendingMediaSelectionSummarySchema = z.object({
  requestId: z.string().uuid(),
  taskId: z.string().min(1),
  title: z.string().max(512),
  createdAt: z.number(),
  expiresAt: z.number(),
  saveDir: z.string(),
  lastError: z.string().optional(),
})
export const PendingMediaSelectionListSchema = z.array(
  PendingMediaSelectionSummarySchema
)
export type PendingMediaSelectionSummary = z.infer<
  typeof PendingMediaSelectionSummarySchema
>
export const PendingMediaSelectionRecordSchema =
  PendingMediaSelectionSummarySchema.extend({
    url: InspectPluginMediaRequestSchema.shape.url,
    preview: MediaSelectionPreviewSchema,
    quality: MediaSelectionQualitySchema.optional(),
    connections: z.number().int().min(1).max(128).optional(),
    dedupKey: z.string().optional(),
    state: z.enum(['pending', 'settled', 'cancelled']),
    created: z.record(z.string(), z.string()),
    encryptedCookies: z.string().optional(),
  })
export type PendingMediaSelectionRecord = z.infer<
  typeof PendingMediaSelectionRecordSchema
>

export function getPendingMediaSelectionRequestId(
  task: Pick<DownloadTask, 'instances'> &
    Partial<Pick<DownloadTask, 'pendingMediaSelection'>>
): string | undefined {
  const marker =
    task.pendingMediaSelection?.requestId ??
    task.instances?.[0]?.payload?.pendingMediaSelection
  return typeof marker === 'string' &&
    z.string().uuid().safeParse(marker).success
    ? marker
    : undefined
}
export function isPendingMediaSelectionTask(
  task: Pick<DownloadTask, 'instances'> &
    Partial<Pick<DownloadTask, 'pendingMediaSelection'>>
): boolean {
  return getPendingMediaSelectionRequestId(task) !== undefined
}
