import { createHash } from 'node:crypto'
import type { BridgeEventBus } from '@core/bridge/bridge-event-bus'
import { IdempotencyCache } from '@core/bridge/idempotency-cache'
import type { MdxpSessionContext } from '@core/bridge/mdxp-session-context'
import type { SegmentAria2 } from '@core/download/segment-downloader'
import { newTaskId } from '@core/lib/ids'
import type { PluginMediaResolution } from '@core/plugin/media-selection-service'
import type { MediaTaskCoordinator } from '@core/task/media-task-coordinator'
import type { TaskManager } from '@core/task/task-manager'
import {
  type DownloadSubmitParams,
  ErrorCodes,
  makeMdxpError,
} from '@motrix/mdxp'
import { clientKey } from '@shared/protocol/bridge'
import { Events } from '@shared/protocol/events'
import type { MediaSelectionPreview } from '@shared/schemas/plugin-media-selection'
import type { DownloadTask, SourceMeta } from '@shared/types/task'
import type { TaskActivityRecorder } from '@shared/types/task-activity'
import type { BridgeErrorCode } from './errors'
import { BridgeReceiverError } from './errors'
import { stripHopByHopHeaders } from './header-replay'
import { MediaTaskRuntime } from './media-task-runtime'
import { DirectPipeline } from './pipelines/direct-pipeline'
import type { HlsDashPipeline } from './pipelines/hls-dash-pipeline'
import { MagnetPipeline } from './pipelines/magnet-pipeline'
import { ensureMediaExtension } from './pipelines/media-final-name'
import type { MuxPipeline } from './pipelines/mux-pipeline'
import { resolvedMediaHeaders } from './plugin-media-resolver'
import {
  dispatchTaskUpdates,
  type TaskNotificationSink,
} from './progress-mapping'
import { ProgressPublisher } from './progress-publisher'
import {
  type AdaptedMux,
  type AdapterDeps,
  SubmitDownloadAdapter,
  sanitizeFilename,
} from './submit-download-adapter'

/**
 * Serialize a list of Cookie objects (from @motrix/mdxp Resource.cookies) into
 * a ready-to-send Cookie header string: `name=value; name=value`.
 * Empty array → empty string. Caller should treat '' as "no cookies".
 */
export function serializeCookieHeader(
  cookies: ReadonlyArray<{ name: string; value: string }>
): string {
  return cookies.map((c) => `${c.name}=${c.value}`).join('; ')
}

export interface BridgeReceiverDeps {
  inspectMedia?: (url: string) => Promise<MediaSelectionPreview | null>
  enqueuePendingMediaSelection?: (input: {
    url: string
    preview: MediaSelectionPreview
    saveDir: string
    source: 'bridge'
    sourceMeta: SourceMeta
    cookies?: string
    dedupKey?: string
  }) => Promise<{ taskId: string }>
  cancelPendingMediaSelection?: (taskId: string) => Promise<void>
  getPendingMediaSelectionChildTaskIds?: (taskId: string) => string[]
  /** Shared host runtime; its lifetime is independent of this listener. */
  mediaRuntime?: MediaTaskRuntime
  mediaMetaStore: ConstructorParameters<
    typeof MediaTaskCoordinator
  >[0]['mediaMetaStore']
  getDefaultSaveDir: AdapterDeps['getDefaultSaveDir']
  resolveSaveDir?: AdapterDeps['resolveSaveDir']
  recordDirectory?: (path: string) => Promise<unknown>
  pickName: AdapterDeps['pickName']
  createTask: ConstructorParameters<typeof DirectPipeline>[0]['createTask']
  removeTask: ConstructorParameters<typeof DirectPipeline>[0]['removeTask']
  submitMagnetForFileSelection: ConstructorParameters<
    typeof MagnetPipeline
  >[0]['submitMagnetForFileSelection']
  isMagnetFileSelectionEnabled: ConstructorParameters<
    typeof MagnetPipeline
  >[0]['isMagnetFileSelectionEnabled']
  eventBus: {
    on(event: string, listener: (payload: unknown) => void): unknown
    off(event: string, listener: (payload: unknown) => void): unknown
    emit?(event: string, payload: unknown): void
  }
  bridgeBus: BridgeEventBus
  localize: (code: BridgeErrorCode) => string
  /** Static fallback for shells without a live FFmpeg resolver. */
  ffmpegBinaryPath: string | null
  /**
   * Live resolver used before accepting media and immediately before muxing.
   * Providing it enables the pipeline even if FFmpeg is absent at startup.
   * Defaults to the startup path for shells/tests without dynamic resolution.
   */
  resolveFfmpegBinaryPath?: () => Promise<string | null>
  taskManager: TaskManager
  activityRecorder: TaskActivityRecorder
  /** Coalesced / immediate TaskUpdated publication (TaskUpdatePublisher),
   *  threaded into the MediaTaskCoordinator this receiver constructs. */
  publishTaskUpdate: () => void
  publishTaskUpdateNow: () => void
  segmentAria2: SegmentAria2
  tmpRoot: string
  /**
   * Durable-save hook for the media coordinator's completion flip (media
   * tasks bypass the aria2 poll loop's transition saves). Wired to the main
   * shell's persistTask; optional so tests and the Node shell can omit it.
   */
  persistTask: (task: DownloadTask) => Promise<void>
  /**
   * Persist a media task and (when non-null) its terminal occurrence in a
   * single durable transaction — used INSTEAD OF `persistTask` whenever a
   * status transition qualifies for one. Optional; absence degrades to
   * plain `persistTask`.
   */
  persistTaskWithOccurrence?: ConstructorParameters<
    typeof MediaTaskCoordinator
  >[0]['persistTaskWithOccurrence']
  /** Delivers a just-committed terminal occurrence to in-process consumers. */
  occurrenceDispatcher?: ConstructorParameters<
    typeof MediaTaskCoordinator
  >[0]['occurrenceDispatcher']
  /**
   * Inspector Activity parent-row barrier for coordinator-owned media tasks.
   * The task must not enter TaskManager until this resolves.
   */
  parentTaskCreated?: ConstructorParameters<
    typeof MediaTaskCoordinator
  >[0]['parentTaskCreated']
  /**
   * Exact post-durable lifecycle recorder for media status transitions.
   */
  recordTransition?: ConstructorParameters<
    typeof MediaTaskCoordinator
  >[0]['recordTransition']
  runTaskMutation?: ConstructorParameters<
    typeof MediaTaskCoordinator
  >[0]['runTaskMutation']
  /**
   * Optional override for manifest fetching. Defaults to the real fetchManifest.
   * Inject a stub in tests to avoid network calls.
   */
  fetchManifest?: (
    url: string,
    opts: { headers?: Record<string, string> }
  ) => Promise<string>
  /** Resolve page submissions before pipeline routing. Null means unclaimed;
   * claimed-provider failures propagate rather than downloading page HTML.
   * Browser cookies are passed only to this resolver, not resolved resources. */
  resolveMedia?: (
    url: string,
    cookieHeader?: string
  ) => Promise<PluginMediaResolution | null>
  /** Legacy mux-only injection retained for existing consumers. */
  resolveToMux?: (
    url: string,
    cookieHeader?: string
  ) => Promise<{
    videoUrl: string
    audioUrl: string
    container: 'mp4' | 'mkv'
    headers?: Record<string, string>
    title?: string
  } | null>
  /**
   * Optional startup gate awaited before any submit reaches a pipeline.
   * The bootstrap resolves it once engine start + SessionManager.restore()
   * have settled. Without it, a submit racing startup restore gets its
   * freshly-registered task wiped by restore's clear() and re-adopted as an
   * engine orphan: name keeps the `.motrix` placeholder, source flips to
   * 'user', sourceMeta is lost, and the taskId already acked to the
   * extension points at a task that no longer exists. Absent ⇒ no gate
   * (tests, Node shell back-compat).
   */
  waitForReady?: () => Promise<void>
}

/**
 * Entry point of subsystem ③. Implements SubmitDownloadHandler from
 * src/core/bridge/web-socket-bridge-server.ts:45 — synchronously returns
 * { taskId } so the server can ack the extension immediately. All
 * progress / completion / error events flow asynchronously via
 * BridgeEventBus.
 */
export class BridgeReceiver {
  private readonly adapter: SubmitDownloadAdapter
  private readonly direct: DirectPipeline
  private readonly magnet: MagnetPipeline
  private readonly publisher: ProgressPublisher
  private readonly hlsDash: HlsDashPipeline | undefined
  private readonly mux: MuxPipeline | undefined
  private readonly coordinator: MediaTaskCoordinator | undefined
  // Terminal-transition dedup for the WS push (same harness as the SSE source).
  private readonly terminalEmitted = new Map<string, string>()
  /**
   * In-flight and settled download/submit results keyed by
   * [authenticated installation key, idempotencyKey]. A retransmit of the same
   * logical submit (lost response, reconnect replay) awaits or receives the original
   * result instead of creating a duplicate task — dedup semantics live in
   * IdempotencyCache (failure eviction, settled-only capacity eviction).
   */
  private readonly submitsByKey = new IdempotencyCache<{
    taskId: string
    requestedSaveDir?: string
  }>()

  constructor(private readonly deps: BridgeReceiverDeps) {
    this.adapter = new SubmitDownloadAdapter({
      getDefaultSaveDir: deps.getDefaultSaveDir,
      resolveSaveDir: deps.resolveSaveDir,
      pickName: deps.pickName,
      mintTaskId: newTaskId,
    })
    this.direct = new DirectPipeline({
      createTask: deps.createTask,
      removeTask: deps.removeTask,
    })
    this.magnet = new MagnetPipeline({
      createTask: deps.createTask,
      removeTask: deps.removeTask,
      submitMagnetForFileSelection: deps.submitMagnetForFileSelection,
      isMagnetFileSelectionEnabled: deps.isMagnetFileSelectionEnabled,
    })
    this.publisher = new ProgressPublisher(deps.bridgeBus, deps.localize)

    const mediaRuntime =
      deps.mediaRuntime ??
      (deps.resolveFfmpegBinaryPath || deps.ffmpegBinaryPath !== null
        ? new MediaTaskRuntime(deps)
        : undefined)
    this.coordinator = mediaRuntime?.coordinator
    this.hlsDash = mediaRuntime?.hlsDashPipeline
    this.mux = mediaRuntime?.muxPipeline
  }

  /**
   * Read-only access to the shared MuxPipeline. Used by the desktop
   * Add-Task path (main/index.ts createDeps) to reuse the same
   * coordinator/mux-pipeline instance — avoids the SP-1 phantom-task
   * bug that would arise from constructing a second coordinator.
   * Undefined only when this shell provides no media runtime. Availability
   * is checked from the live resolver on every dispatch.
   */
  get muxPipeline(): MuxPipeline | undefined {
    return this.mux
  }

  /**
   * Active aria2 segment gids for a coordinator-managed media task (kind
   * Mux/Hls). These ARE real aria2 gids — unlike the task's empty engineTaskId
   * — so pause/resume can act on them. Returns [] when the task is unknown, is
   * past the download phase, or this shell has no media runtime.
   */
  getMediaSegmentGids(taskId: string): string[] {
    return this.coordinator?.getActiveSegmentGids(taskId) ?? []
  }

  /** SubmitDownloadHandler: the bridge dispatcher injects this. */
  async handle(
    params: DownloadSubmitParams,
    ctx: MdxpSessionContext
  ): Promise<{ taskId: string }> {
    // download/submit is extension-only. The agent-facing gate already keeps a
    // cli off this method at the unary layer; this is the defense-in-depth
    // guard so the receiver never reads extensionId/browser off a cli identity.
    if (ctx.identity.kind !== 'extension') {
      throw makeMdxpError(
        ErrorCodes.CapabilityNotSupported,
        `download/submit is not available to ${ctx.identity.kind} clients`
      )
    }
    const identity = ctx.identity
    const sessionKey = ctx.sessionKey ?? clientKey(identity)
    const key = params.idempotencyKey
    if (!key) return this.dispatchSubmit(params, identity, sessionKey)

    const result = await this.submitsByKey.run(
      JSON.stringify([sessionKey, key]),
      async () => ({
        ...(await this.dispatchSubmit(params, identity, sessionKey)),
        requestedSaveDir: params.saveDir,
      })
    )
    if (result.requestedSaveDir !== params.saveDir) {
      throw makeMdxpError(
        ErrorCodes.InvalidParams,
        'Submission key was already used with another directory'
      )
    }
    return { taskId: result.taskId }
  }

  private async dispatchSubmit(
    params: DownloadSubmitParams,
    identity: Extract<MdxpSessionContext['identity'], { kind: 'extension' }>,
    sessionKey: string
  ): Promise<{ taskId: string }> {
    // Hold the submit until startup restore has settled (see the dep doc).
    // Awaited before adapt so even the name pick sees the
    // final on-disk state left by restore/recovery.
    if (this.deps.waitForReady) {
      await this.deps.waitForReady()
    }
    const adapted = await this.adapter.adapt(params, {
      extensionId: identity.extensionId,
      browser: identity.browser,
      sessionKey,
    })

    const result = await this.dispatchAdapted(adapted, params)
    // A history-write failure must never turn an accepted task into a retry.
    void Promise.resolve()
      .then(() => this.deps.recordDirectory?.(adapted.saveDir))
      .catch(() => {})
    return result
  }

  private async dispatchAdapted(
    adapted: Awaited<ReturnType<SubmitDownloadAdapter['adapt']>>,
    params: DownloadSubmitParams
  ): Promise<{ taskId: string }> {
    // Resolve once, inside the installation-scoped idempotency operation.
    // Resource headers replace page headers; browser cookies stay API-only.
    if (
      adapted.kind === 'direct' &&
      (this.deps.inspectMedia ||
        this.deps.resolveMedia ||
        this.deps.resolveToMux)
    ) {
      const rawCookies =
        params.selection.kind === 'direct'
          ? params.selection.primary.cookies
          : []
      const serialized = serializeCookieHeader(rawCookies)
      const cookieHeader = serialized || undefined
      const preview = await this.deps.inspectMedia?.(adapted.primaryUrl)
      if (
        preview &&
        (preview.entries.length > 1 || preview.showSinglePartDialog === true) &&
        this.deps.enqueuePendingMediaSelection
      ) {
        const receipt = params.idempotencyKey
          ? createHash('sha256')
              .update(
                JSON.stringify([
                  adapted.sourceMeta.sessionKey,
                  params.idempotencyKey,
                ])
              )
              .digest('hex')
          : undefined
        return this.deps.enqueuePendingMediaSelection({
          url: adapted.primaryUrl,
          preview,
          saveDir: adapted.saveDir,
          source: 'bridge',
          sourceMeta: adapted.sourceMeta,
          ...(cookieHeader ? { cookies: cookieHeader } : {}),
          ...(receipt ? { dedupKey: `bridge:${receipt}` } : {}),
        })
      }
      const resolved = this.deps.resolveMedia
        ? await this.deps.resolveMedia(adapted.primaryUrl, cookieHeader)
        : null
      if (resolved?.kind === 'direct') {
        const title = sanitizeFilename(resolved.title ?? '').trim()
        const extension =
          /\.(mp4|mkv|webm|mov|m4v|ts|flv|m4a|aac|mp3|opus)$/i.exec(
            new URL(resolved.directUrl).pathname
          )?.[0]
        const name = title
          ? extension && !title.toLowerCase().endsWith(extension.toLowerCase())
            ? `${title}${extension}`
            : title
          : ''
        return this.direct.dispatch({
          ...adapted,
          primaryUrl: resolved.directUrl,
          mediaResolved: true,
          sanitizedHeaders: resolvedMediaHeaders(resolved.headers),
          cookies: [],
          ...(name
            ? {
                finalName: await this.deps.pickName(adapted.saveDir, name),
                discoverFilename: undefined,
              }
            : { discoverFilename: true }),
        })
      }
      const m =
        resolved?.kind === 'mux'
          ? {
              videoUrl: resolved.video.url,
              audioUrl: resolved.audio.url,
              headers: {},
              container: resolved.container,
              title: resolved.title,
            }
          : this.deps.resolveMedia
            ? null
            : await this.deps.resolveToMux?.(adapted.primaryUrl, cookieHeader)
      if (m) {
        if (!this.mux) {
          throw new BridgeReceiverError(
            'unsupported-kind',
            'ffmpeg unavailable — mux pipeline not active'
          )
        }
        // Prefer the resolver's human title over the URL-derived name (a bvid
        // like BV1xxx is meaningless). Sanitize, append the container
        // extension, THEN dedup — the pick must run on the on-disk name.
        const titleBase = m.title ? sanitizeFilename(m.title).trim() : ''
        const finalName = titleBase
          ? await this.deps.pickName(
              adapted.saveDir,
              ensureMediaExtension(titleBase, m.container)
            )
          : adapted.finalName
        const muxAdapted: AdaptedMux = {
          kind: 'mux',
          taskId: adapted.taskId,
          saveDir: adapted.saveDir,
          finalName,
          videoUrl: m.videoUrl,
          audioUrl: m.audioUrl,
          ...(resolved?.kind === 'mux'
            ? {
                videoHeaders: resolvedMediaHeaders(resolved.video.headers),
                audioHeaders: resolvedMediaHeaders(resolved.audio.headers),
              }
            : {}),
          sanitizedHeaders: m.headers
            ? stripHopByHopHeaders(m.headers)
            : adapted.sanitizedHeaders,
          container: m.container,
          sourceMeta: adapted.sourceMeta,
          ...(adapted.sourceMeta.durationSec != null
            ? { durationSec: adapted.sourceMeta.durationSec }
            : {}),
        }
        return this.mux.dispatch(muxAdapted)
      }
    }

    if (adapted.kind === 'magnet') {
      return this.magnet.dispatch(adapted)
    }
    if (adapted.kind === 'hls' || adapted.kind === 'dash') {
      if (!this.hlsDash) {
        throw new BridgeReceiverError(
          'unsupported-kind',
          'ffmpeg unavailable — hls/dash pipeline not active'
        )
      }
      return this.hlsDash.dispatch(adapted)
    }
    if (adapted.kind === 'mux') {
      if (!this.mux) {
        throw new BridgeReceiverError(
          'unsupported-kind',
          'ffmpeg unavailable — mux pipeline not active'
        )
      }
      return this.mux.dispatch(adapted)
    }
    return this.direct.dispatch(adapted)
  }

  private readonly sink: TaskNotificationSink = {
    onProgress: (task) => this.publisher.onTaskUpdated(task),
    onCompleted: (task) => this.publisher.onTaskCompleted(task),
    onError: (task, code) => this.publisher.onTaskFailed(task, code),
  }

  // Stored so stop() can unsubscribe the exact reference.
  private readonly handleTaskUpdated = (payload: unknown): void => {
    if (!Array.isArray(payload)) return
    dispatchTaskUpdates(
      payload as DownloadTask[],
      this.terminalEmitted,
      this.sink
    )
  }

  /**
   * Subscribe to the core EventBus. The only reliable task signal is
   * `Events.TaskUpdated`, which carries the FULL task list each poll tick
   * (TaskCompleted/TaskFailed are never emitted on the core bus). So iterate the
   * array through the shared `dispatchTaskUpdates` harness — it emits progress
   * per task and DERIVES completed/error from terminal status (deduped) — and
   * let `ProgressPublisher` apply the `source==='bridge'` filter + per-session
   * routing. Same derivation the SSE firehose uses.
   */
  start(): void {
    this.deps.eventBus.on(Events.TaskUpdated, this.handleTaskUpdated)
  }

  /**
   * Unsubscribe from the core EventBus. Called from the bootstrap shutdown so a
   * re-enabled bridge doesn't leak this (now dead) receiver instance — the core
   * EventBus is a process-lifetime singleton.
   */
  stop(): void {
    this.deps.eventBus.off(Events.TaskUpdated, this.handleTaskUpdated)
    this.terminalEmitted.clear()
  }

  /**
   * Stop publishing and drain media runs when this receiver owns the runtime.
   * An injected host runtime survives listener shutdown and is drained by the
   * shell alongside the engine and session lifecycle.
   */
  async stopAndDrain(): Promise<void> {
    this.stop()
    if (!this.deps.mediaRuntime) await this.coordinator?.stopAndDrain()
  }

  /** Extension-initiated cancel. `taskId` is the MDXP public id
   *  (== DownloadTask.id), not an aria2 gid. The receiver does not know
   *  which subsystem owns the task, so both the direct pipeline and the
   *  media coordinator are tried defensively; not-found is silently swallowed. */
  async cancel(taskId: string): Promise<void> {
    await this.deps.cancelPendingMediaSelection?.(taskId)
    const children =
      this.deps.getPendingMediaSelectionChildTaskIds?.(taskId) ?? []
    await Promise.all(children.map((child) => this.cancel(child)))
    await Promise.allSettled([
      this.direct.cancel(taskId),
      this.coordinator?.cancel(taskId),
    ])
  }

  /**
   * Tear down ONLY a coordinator-managed media task's in-flight run (segment
   * downloaders + ffmpeg + temp dir). No-op once the run has finished. Unlike
   * cancel(), this deliberately does NOT touch the DirectPipeline:
   * DirectPipeline.cancel routes back into removeTask, and this method is
   * invoked FROM removeTask's media-teardown branch — going through cancel()
   * would recurse (removeTask → cancelMedia → direct.cancel → removeTask → …).
   */
  async cancelMedia(taskId: string): Promise<void> {
    await this.coordinator?.cancel(taskId)
  }

  /**
   * On startup, revive any bridge-sourced state that survives a restart.
   * v1.0 needs nothing here: the aria2 session resumes in-flight tasks and
   * start() arms the EventBus subscriptions. Kept as the v1.1+ hook for
   * HLS / mux segment revival.
   */
  async restoreInflight(): Promise<void> {}
}
