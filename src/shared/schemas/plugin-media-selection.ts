import {
  InspectMediaArgsSchema,
  MediaCollectionSchema,
} from '@motrix/plugin-manifest-schema'
import { z } from 'zod'

export const MediaSelectionQualitySchema = z.enum([
  '2160p',
  '1440p',
  '1080p',
  '720p',
  '480p',
])
export type MediaSelectionQuality = z.infer<typeof MediaSelectionQualitySchema>

export const InspectPluginMediaRequestSchema = InspectMediaArgsSchema

export const MediaSelectionPreviewSchema = z
  .strictObject({
    ...MediaCollectionSchema.shape,
    selectionId: z.string().uuid(),
    pluginId: z.string().min(1).max(256),
    expiresAt: z.number().int().positive(),
    showSinglePartDialog: z.boolean().optional(),
  })
  .omit({ schemaVersion: true })
export type MediaSelectionPreview = z.infer<typeof MediaSelectionPreviewSchema>

export const CreatePluginMediaTasksRequestSchema = z
  .object({
    selectionId: z.string().uuid(),
    entryIds: z
      .array(z.string().min(1).max(256))
      .min(1)
      .max(500)
      .refine(
        (ids) => new Set(ids).size === ids.length,
        'Duplicate media entries'
      ),
    quality: MediaSelectionQualitySchema,
    saveDir: z.string().min(1).max(4096),
    connections: z.number().int().min(1).max(128).optional(),
  })
  .strict()
export type CreatePluginMediaTasksRequest = z.infer<
  typeof CreatePluginMediaTasksRequestSchema
>

export const CreatePluginMediaTasksResultSchema = z.object({
  created: z.array(z.object({ entryId: z.string(), taskId: z.string() })),
  failed: z.array(z.object({ entryId: z.string(), message: z.string() })),
})
export type CreatePluginMediaTasksResult = z.infer<
  typeof CreatePluginMediaTasksResultSchema
>
export type MediaSelectionCreateResult = CreatePluginMediaTasksResult
