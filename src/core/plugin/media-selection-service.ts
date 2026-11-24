import { randomUUID } from 'node:crypto'
import {
  InspectMediaArgsSchema,
  type MediaCollection,
  MediaCollectionSchema,
} from '@motrix/plugin-manifest-schema'
import { AppError, ErrorCode } from '@shared/errors'
import {
  type CreatePluginMediaTasksRequest,
  CreatePluginMediaTasksRequestSchema,
  type CreatePluginMediaTasksResult,
  InspectPluginMediaRequestSchema,
  type MediaSelectionPreview,
} from '@shared/schemas/plugin-media-selection'
import { z } from 'zod'
import type { PluginHost } from './host/plugin-host'
import { matchesAnyHostPermission } from './permissions/host-pattern'
import type { PluginRegistry } from './plugin-registry'

const mediaUrl = InspectMediaArgsSchema.shape.url
const headers = z
  .record(z.string().min(1).max(256), z.string().max(16384))
  .refine(
    (value) =>
      Object.keys(value).length <= 64 &&
      Object.entries(value).every(
        ([name, content]) => !/[\r\n\0]/.test(name + content)
      ),
    'Invalid media headers'
  )
const stream = z.object({ url: mediaUrl, headers: headers.optional() }).strict()
export const PluginMediaResolutionSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('direct'),
      directUrl: mediaUrl,
      headers: headers.optional(),
      title: z.string().max(512).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('mux'),
      video: stream,
      audio: stream,
      container: z.enum(['mp4', 'mkv']).default('mp4'),
      title: z.string().max(512).optional(),
    })
    .strict(),
])
export type PluginMediaResolution = z.infer<typeof PluginMediaResolutionSchema>
export interface PluginMediaTaskInput {
  entry: MediaCollection['entries'][number]
  resolution: PluginMediaResolution
  saveDir: string
  connections?: number
  pluginId: string
}
interface Options {
  registry: Pick<PluginRegistry, 'entries' | 'policySnapshot'>
  host: Pick<PluginHost, 'activate' | 'invokeCommand'>
  createTask: (input: PluginMediaTaskInput) => Promise<string>
  readPluginConfig: (pluginId: string) => Record<string, unknown>
  now?: () => number
}
interface Session {
  preview: MediaSelectionPreview
  generation: number
  executableDigest: string
  created: Map<string, string>
  tail: Promise<unknown>
  pending: number
}
const SESSION_TTL_MS = 10 * 60_000
const MAX_SESSIONS = 64

/** Host-owned selection receipts bind user choices to a validated provider result. */
export class PluginMediaSelectionService {
  private readonly sessions = new Map<string, Session>()
  private readonly now: () => number
  constructor(private readonly options: Options) {
    this.now = options.now ?? Date.now
  }

  async inspect(raw: unknown): Promise<MediaSelectionPreview | null> {
    const { url } = InspectPluginMediaRequestSchema.parse(raw)
    mediaUrl.parse(url)
    this.prune()
    const providers = this.options.registry
      .entries()
      .filter(
        (entry) =>
          entry.enabled &&
          entry.executableDigest &&
          entry.manifest.categories?.includes('site-resolver') &&
          matchesAnyHostPermission(entry.manifest.hostPermissions, url) &&
          ['inspectMedia', 'resolve'].every((suffix) =>
            entry.manifest.contributes.commands?.some(
              (command) =>
                command.public === true &&
                command.id === `${entry.manifest.id}.${suffix}`
            )
          )
      )
      .sort((a, b) =>
        a.origin === b.origin
          ? a.manifest.id.localeCompare(b.manifest.id)
          : a.origin === 'builtin'
            ? -1
            : 1
      )
    for (const entry of providers) {
      const pluginId = entry.manifest.id
      const policy = this.options.registry.policySnapshot(pluginId)
      if (!policy?.enabled || !policy.executableDigest) continue
      await this.options.host.activate(pluginId)
      const result = await this.options.host.invokeCommand(
        pluginId,
        `${pluginId}.inspectMedia`,
        { url }
      )
      if (result === null) continue
      const collection = MediaCollectionSchema.parse(result)
      // A provider may redirect b23.tv to its declared Bilibili host, but may
      // not use this receipt to submit arbitrary third-party page URLs.
      for (const part of collection.entries) {
        if (
          !matchesAnyHostPermission(entry.manifest.hostPermissions, part.url)
        ) {
          throw new Error('Media provider returned an undeclared page host')
        }
      }
      this.assertPolicy(pluginId, policy.generation, policy.executableDigest)
      if (this.sessions.size >= MAX_SESSIONS) {
        const oldest = [...this.sessions.entries()].find(
          ([, value]) => value.pending === 0
        )
        if (!oldest) throw new Error('Too many active media selections')
        this.sessions.delete(oldest[0])
      }
      const preview: MediaSelectionPreview = {
        selectionId: randomUUID(),
        pluginId,
        title: collection.title,
        entries: collection.entries,
        qualities: collection.qualities,
        defaultQuality: collection.defaultQuality,
        expiresAt: this.now() + SESSION_TTL_MS,
      }
      const configSchema = entry.manifest.contributes.configuration?.schema
      const properties =
        configSchema &&
        typeof configSchema === 'object' &&
        'properties' in configSchema &&
        configSchema.properties &&
        typeof configSchema.properties === 'object'
          ? (configSchema.properties as Record<string, unknown>)
          : {}
      const dialogSetting = properties.showSinglePartDialog
      if (
        dialogSetting &&
        typeof dialogSetting === 'object' &&
        'type' in dialogSetting &&
        dialogSetting.type === 'boolean'
      ) {
        const stored =
          this.options.readPluginConfig(pluginId).showSinglePartDialog
        preview.showSinglePartDialog =
          typeof stored === 'boolean'
            ? stored
            : 'default' in dialogSetting &&
                typeof dialogSetting.default === 'boolean'
              ? dialogSetting.default
              : false
      }
      this.sessions.set(preview.selectionId, {
        preview,
        generation: policy.generation,
        executableDigest: policy.executableDigest,
        created: new Map(),
        tail: Promise.resolve(),
        pending: 0,
      })
      return structuredClone(preview)
    }
    return null
  }

  async create(raw: unknown): Promise<CreatePluginMediaTasksResult> {
    const request = CreatePluginMediaTasksRequestSchema.parse(raw)
    const session = this.sessions.get(request.selectionId)
    if (!session || session.preview.expiresAt <= this.now()) {
      throw new Error('Media selection expired; inspect the link again')
    }
    if (
      !(session.preview.qualities as readonly string[]).includes(
        request.quality
      )
    ) {
      throw new Error('The selected quality was not offered')
    }
    const known = new Set(session.preview.entries.map((entry) => entry.id))
    if (request.entryIds.some((id) => !known.has(id))) {
      throw new Error('Unknown media selection entry')
    }
    session.pending += 1
    const operation = session.tail
      .catch(() => undefined)
      .then(() => this.createSelected(session, request))
    session.tail = operation
    try {
      return await operation
    } finally {
      session.pending -= 1
    }
  }

  private async createSelected(
    session: Session,
    request: CreatePluginMediaTasksRequest
  ): Promise<CreatePluginMediaTasksResult> {
    const result: CreatePluginMediaTasksResult = { created: [], failed: [] }
    const { pluginId } = session.preview
    for (const entryId of request.entryIds) {
      const existing = session.created.get(entryId)
      if (existing) {
        result.created.push({ entryId, taskId: existing })
        continue
      }
      const entry = session.preview.entries.find((part) => part.id === entryId)
      if (!entry) {
        result.failed.push({
          entryId,
          message: 'Unknown media selection entry',
        })
        continue
      }
      try {
        this.assertPolicy(
          pluginId,
          session.generation,
          session.executableDigest
        )
        await this.options.host.activate(pluginId)
        const raw = await this.options.host.invokeCommand(
          pluginId,
          `${pluginId}.resolve`,
          {
            url: entry.url,
            quality: request.quality,
          }
        )
        const resolution = PluginMediaResolutionSchema.parse(raw)
        this.assertPolicy(
          pluginId,
          session.generation,
          session.executableDigest
        )
        const taskId = await this.options.createTask({
          entry,
          resolution,
          pluginId,
          saveDir: request.saveDir,
          ...(request.connections ? { connections: request.connections } : {}),
        })
        session.created.set(entryId, taskId)
        result.created.push({ entryId, taskId })
      } catch (error) {
        // The server's directory policy failure (directoryCode on the
        // AppError) is user-facing; surface its message per entry. Other
        // provider errors may include signed URLs or cookies, so keep a
        // generic per-entry failure and detailed logs in the provider.
        const message =
          error instanceof AppError &&
          error.code === ErrorCode.TaskCreateFailed &&
          typeof (error as { directoryCode?: unknown }).directoryCode ===
            'string'
            ? error.message
            : 'Unable to create this video download'
        result.failed.push({ entryId, message })
      }
    }
    return result
  }

  private assertPolicy(
    pluginId: string,
    generation: number,
    digest: string
  ): void {
    const policy = this.options.registry.policySnapshot(pluginId)
    if (
      !policy?.enabled ||
      policy.generation !== generation ||
      policy.executableDigest !== digest
    ) {
      throw new Error('Media provider changed; inspect the link again')
    }
  }

  private prune(): void {
    for (const [id, session] of this.sessions) {
      if (session.pending === 0 && session.preview.expiresAt <= this.now())
        this.sessions.delete(id)
    }
  }
}
