import { randomUUID } from 'node:crypto'
import type {
  MotrixDatabase,
  TaskWithInstances,
} from '@core/session/motrix-database'
import { scopedCreateRequestId } from '@core/task/create-request-id'
import type { TaskManager } from '@core/task/task-manager'
import { taskRowToDownloadTask } from '@core/task/task-row-to-download-task'
import { AppError, ErrorCode } from '@shared/errors'
import {
  ConfirmPendingMediaSelectionSchema,
  EnqueuePendingMediaSelectionSchema,
  type PendingMediaSelectionRecord,
  type PendingMediaSelectionSummary,
} from '@shared/schemas/pending-media-selection'
import {
  type CreatePluginMediaTasksResult,
  type MediaSelectionPreview,
  MediaSelectionPreviewSchema,
} from '@shared/schemas/plugin-media-selection'
import {
  type SourceMeta,
  TaskInstancePhase,
  TaskKind,
  type TaskSource,
  TaskStatus,
  TaskType,
  TransitionPhase,
} from '@shared/types/task'
import type { PluginMediaSelectionService } from './media-selection-service'
import { PendingMediaSelectionRepository } from './pending-media-selection-repository'

interface Options {
  db: MotrixDatabase
  taskManager: TaskManager
  mediaSelection: Pick<PluginMediaSelectionService, 'inspect' | 'create'>
  now?: () => number
  onChange?: (change: {
    requestId: string
    taskId: string
    state: 'pending' | 'settled' | 'cancelled'
  }) => void
  encrypt?: (value: string) => string | Promise<string>
  decrypt?: (value: string) => string | Promise<string>
}
interface EnqueueExtras {
  preview?: MediaSelectionPreview
  source?: TaskSource
  sourceMeta?: SourceMeta
  cookies?: string
}
const RETENTION_MS = 7 * 24 * 60 * 60_000
const MAX_QUEUE = 128

/** Durable user choices. Resolution URLs and credentials never enter queue JSON. */
export class PendingMediaSelectionService {
  private readonly repository: PendingMediaSelectionRepository
  private readonly tails = new Map<string, Promise<unknown>>()
  private readonly now: () => number
  constructor(private readonly options: Options) {
    this.repository = new PendingMediaSelectionRepository(options.db.database)
    this.now = options.now ?? Date.now
  }

  async enqueue(raw: unknown): Promise<{ requestId: string; taskId: string }> {
    const input = EnqueuePendingMediaSelectionSchema.parse(raw)
    const extras = raw as EnqueueExtras
    if (input.dedupKey) {
      const known = this.repository.findByDedupKey(input.dedupKey)
      if (known) return { requestId: known.requestId, taskId: known.taskId }
    }
    if (extras.cookies && (!this.options.encrypt || !this.options.decrypt)) {
      throw new AppError(
        ErrorCode.PluginCapabilityUnavailable,
        'Encrypted cookie storage is unavailable'
      )
    }
    this.prune()
    if (
      this.repository
        .list()
        .filter((row) => row.state === 'pending' && row.expiresAt > this.now())
        .length >= MAX_QUEUE
    )
      throw new AppError(
        ErrorCode.IpcRateLimited,
        'Pending media queue is full'
      )
    const preview = extras.preview
      ? MediaSelectionPreviewSchema.parse(extras.preview)
      : await this.options.mediaSelection.inspect({ url: input.url })
    if (!preview)
      throw new AppError(
        ErrorCode.InvalidSelection,
        'No media provider supports this page'
      )
    const timestamp = this.now()
    const requestId = randomUUID()
    const record: PendingMediaSelectionRecord = {
      ...input,
      requestId,
      taskId: requestId,
      title: preview.title,
      preview,
      createdAt: timestamp,
      expiresAt: timestamp + RETENTION_MS,
      state: 'pending',
      created: {},
      ...(extras.cookies && this.options.encrypt
        ? { encryptedCookies: await this.options.encrypt(extras.cookies) }
        : {}),
    }
    // Recheck after asynchronous inspection: two clients can enqueue the same receipt.
    if (input.dedupKey) {
      const known = this.repository.findByDedupKey(input.dedupKey)
      if (known) return { requestId: known.requestId, taskId: known.taskId }
    }
    if (
      this.repository
        .list()
        .filter((row) => row.state === 'pending' && row.expiresAt > this.now())
        .length >= MAX_QUEUE
    )
      throw new AppError(
        ErrorCode.IpcRateLimited,
        'Pending media queue is full'
      )
    const pair = waitingTask(
      record,
      extras.source ?? 'user',
      extras.sourceMeta ?? null
    )
    this.options.db.database.transaction(() => {
      this.repository.put(record)
      this.options.db.saveTaskWithInstances(pair)
    })()
    this.options.taskManager.set(
      record.taskId,
      taskRowToDownloadTask(pair.task, pair.instances)
    )
    this.emit(record)
    return { requestId: record.requestId, taskId: record.taskId }
  }

  list(): PendingMediaSelectionSummary[] {
    this.prune()
    return this.repository
      .list()
      .filter(
        (record) => record.state === 'pending' && record.expiresAt > this.now()
      )
      .map(
        ({
          requestId,
          taskId,
          title,
          createdAt,
          expiresAt,
          saveDir,
          lastError,
        }) => ({
          requestId,
          taskId,
          title,
          createdAt,
          expiresAt,
          saveDir,
          ...(lastError ? { lastError } : {}),
        })
      )
  }

  get(requestId: string): Promise<MediaSelectionPreview | null> {
    return this.exclusive(requestId, async () => {
      const record = this.repository.get(requestId)
      if (record?.state !== 'pending') return null
      const preview = await this.refresh(record)
      return {
        ...preview,
        entries: preview.entries.filter((entry) => !record.created[entry.id]),
      }
    })
  }

  getRecord(requestId: string): PendingMediaSelectionRecord | undefined {
    return this.repository.get(requestId)
  }

  getChildTaskIds(requestId: string): string[] {
    const record =
      this.repository.get(requestId) ??
      this.repository.list().find((row) => row.taskId === requestId)
    return record ? Object.values(record.created) : []
  }

  confirm(raw: unknown): Promise<CreatePluginMediaTasksResult> {
    const input = ConfirmPendingMediaSelectionSchema.parse(raw)
    return this.exclusive(input.requestId, async () => {
      const record = this.repository.get(input.requestId)
      if (!record || record.state === 'cancelled')
        throw new AppError(
          ErrorCode.TaskNotFound,
          'Pending media selection was removed'
        )
      const known = new Set(record.preview.entries.map((entry) => entry.id))
      if (input.entryIds.some((id) => !known.has(id)))
        throw new AppError(
          ErrorCode.InvalidSelection,
          'Unknown pending media entry'
        )
      const result: CreatePluginMediaTasksResult = { created: [], failed: [] }
      for (const entryId of input.entryIds) {
        const receipt = scopedCreateRequestId(record.requestId, entryId)
        const owner = this.options.taskManager
          .getAll()
          .find((task) =>
            task.instances.some(
              (instance) => instance.payload.createRequestId === receipt
            )
          )
        if (owner) record.created[entryId] = owner.id
      }
      this.repository.put(record)
      const remaining = input.entryIds.filter((id) => !record.created[id])
      if (record.state === 'settled' && remaining.length)
        throw new AppError(
          ErrorCode.InvalidSelection,
          'Media selection already settled'
        )
      const preview = remaining.length
        ? await this.refresh(record)
        : record.preview
      for (const entryId of input.entryIds) {
        if (record.created[entryId]) {
          result.created.push({ entryId, taskId: record.created[entryId] })
          continue
        }
        const created = await this.options.mediaSelection.create(
          {
            selectionId: preview.selectionId,
            entryIds: [entryId],
            quality: input.quality,
            saveDir: record.saveDir,
            ...(record.connections ? { connections: record.connections } : {}),
          },
          {
            requestId: record.requestId,
            source:
              this.options.db.getTask(record.taskId)?.task.source ?? 'user',
            sourceMeta:
              this.options.db.getTask(record.taskId)?.task.sourceMeta ?? null,
            ...(record.encryptedCookies
              ? { cookies: await this.decryptCookies(record.encryptedCookies) }
              : {}),
          }
        )
        for (const item of created.created)
          record.created[item.entryId] = item.taskId
        result.created.push(...created.created)
        result.failed.push(...created.failed)
        // Commit each receipt before attempting another entry, preserving partial success.
        this.repository.put(record)
      }
      if (!result.failed.length) {
        record.state = 'settled'
        delete record.lastError
        this.options.db.database.transaction(() => {
          this.repository.put(record)
          this.options.db.deleteTask(record.taskId)
        })()
        this.options.taskManager.remove(record.taskId)
      } else {
        record.lastError = 'Some selected media entries need another attempt'
        this.repository.put(record)
      }
      this.emit(record)
      return result
    })
  }

  cancel(
    requestId: string,
    options?: { deleteParent?: boolean }
  ): Promise<void> {
    const canonicalId =
      this.repository.get(requestId)?.requestId ??
      this.repository.list().find((row) => row.taskId === requestId)
        ?.requestId ??
      requestId
    return this.exclusive(canonicalId, async () => {
      const record =
        this.repository.get(requestId) ??
        this.repository.list().find((row) => row.taskId === requestId)
      if (!record || record.state === 'cancelled') return
      record.state = 'cancelled'
      this.options.db.database.transaction(() => {
        this.repository.put(record)
        if (options?.deleteParent !== false)
          this.options.db.deleteTask(record.taskId)
      })()
      if (options?.deleteParent !== false)
        this.options.taskManager.remove(record.taskId)
      this.emit(record)
    })
  }

  private async decryptCookies(value: string): Promise<string> {
    if (!this.options.decrypt)
      throw new AppError(
        ErrorCode.PluginCapabilityUnavailable,
        'Encrypted cookie storage is unavailable'
      )
    return this.options.decrypt(value)
  }

  private async refresh(
    record: PendingMediaSelectionRecord
  ): Promise<MediaSelectionPreview> {
    try {
      if (record.expiresAt <= this.now())
        throw new AppError(
          ErrorCode.InvalidSelection,
          'Pending media selection expired'
        )
      const preview = await this.options.mediaSelection.inspect({
        url: record.url,
      })
      if (!preview || preview.pluginId !== record.preview.pluginId)
        throw new AppError(
          ErrorCode.PluginCapabilityUnavailable,
          'The original media provider is unavailable'
        )
      record.preview = preview
      delete record.lastError
      this.repository.put(record)
      return preview
    } catch (error) {
      const message =
        'Media preview needs attention; refresh after checking the provider'
      const changed = record.lastError !== message
      record.lastError = message
      this.repository.put(record)
      if (changed) this.emit(record)
      throw new AppError(ErrorCode.InvalidSelection, record.lastError, error)
    }
  }

  private exclusive<T>(
    requestId: string,
    operation: () => Promise<T>
  ): Promise<T> {
    const previous = this.tails.get(requestId) ?? Promise.resolve()
    const next = previous.catch(() => undefined).then(operation)
    this.tails.set(requestId, next)
    void next
      .finally(() => {
        if (this.tails.get(requestId) === next) this.tails.delete(requestId)
      })
      .catch(() => undefined)
    return next
  }
  private emit(record: PendingMediaSelectionRecord): void {
    this.options.onChange?.({
      requestId: record.requestId,
      taskId: record.taskId,
      state: record.state,
    })
  }
  private prune(): void {
    const now = this.now()
    for (const record of this.repository.list()) {
      if (
        record.state === 'pending' &&
        record.expiresAt <= now &&
        !this.tails.has(record.requestId)
      ) {
        record.state = 'cancelled'
        record.expiresAt = now + RETENTION_MS
        this.options.db.database.transaction(() => {
          this.repository.put(record)
          this.options.db.deleteTask(record.taskId)
        })()
        this.options.taskManager.remove(record.taskId)
        this.emit(record)
      }
    }
    const receipts = this.repository
      .list()
      .filter((record) => record.state !== 'pending')
    for (const [index, record] of receipts.entries()) {
      if (record.expiresAt <= now || index < receipts.length - 2048)
        this.repository.remove(record.requestId)
    }
  }
}

function waitingTask(
  record: PendingMediaSelectionRecord,
  source: TaskSource,
  sourceMeta: SourceMeta
): TaskWithInstances {
  const { taskId, createdAt } = record
  return {
    task: {
      motrixId: taskId,
      name: record.title,
      kind: TaskKind.Direct,
      taskType: TaskType.Http,
      saveDir: record.saveDir,
      category: null,
      priority: 0,
      tags: null,
      createdAt,
      updatedAt: createdAt,
      finalPath: '',
      finalName: '',
      torrentMetaPath: null,
      infoHash: null,
      totalBytes: 0,
      downloadedBytes: 0,
      sizeWhenDone: 0,
      fileCount: 0,
      isPrivate: false,
      trackers: [],
      pieceLength: 0,
      aggStatus: TaskStatus.MetadataReady,
      finishedAt: null,
      errorMessage: null,
      errorCode: null,
      errorDetailKey: null,
      errorDetailParams: null,
      diagnosisRevision: 0,
      uploadedBytesBaseline: 0,
      source,
      sourceMeta,
    },
    instances: [
      {
        instanceId: randomUUID(),
        motrixId: taskId,
        gid: null,
        phase: TaskInstancePhase.HttpDownload,
        status: TaskStatus.MetadataReady,
        progress: 0,
        totalBytes: 0,
        downloadedBytes: 0,
        uploadedBytes: 0,
        diskPath: '',
        transitionPhase: TransitionPhase.Idle,
        uris: [],
        uriHash: null,
        payload: { pendingMediaSelection: record.requestId },
        createdAt,
        updatedAt: createdAt,
      },
    ],
  }
}
