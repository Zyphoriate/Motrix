import fs from 'node:fs'
import path from 'node:path'
import { SegmentDownloader } from '@core/download/segment-downloader'
import { FfmpegService } from '@core/ffmpeg/ffmpeg-service'
import { fetchManifest } from '@core/media/manifest-fetcher'
import { assembleSegments } from '@core/media/segment-assembler'
import { SegmentDecryptor } from '@core/media/segment-decryptor'
import { MediaTaskCoordinator } from '@core/task/media-task-coordinator'
import type { BridgeReceiverDeps } from './bridge-receiver'
import { BridgeReceiverError } from './errors'
import { HlsDashPipeline } from './pipelines/hls-dash-pipeline'
import { MuxPipeline } from './pipelines/mux-pipeline'

export type MediaTaskRuntimeDeps = Pick<
  BridgeReceiverDeps,
  | 'mediaMetaStore'
  | 'taskManager'
  | 'activityRecorder'
  | 'eventBus'
  | 'publishTaskUpdate'
  | 'publishTaskUpdateNow'
  | 'ffmpegBinaryPath'
  | 'resolveFfmpegBinaryPath'
  | 'pickName'
  | 'persistTask'
  | 'persistTaskWithOccurrence'
  | 'occurrenceDispatcher'
  | 'parentTaskCreated'
  | 'recordTransition'
  | 'runTaskMutation'
  | 'segmentAria2'
  | 'tmpRoot'
  | 'fetchManifest'
>

/** Host-owned media jobs survive extension listener disable/restart. */
export class MediaTaskRuntime {
  readonly coordinator: MediaTaskCoordinator
  readonly muxPipeline: MuxPipeline
  readonly hlsDashPipeline: HlsDashPipeline

  constructor(deps: MediaTaskRuntimeDeps) {
    const resolveFfmpegBinaryPath =
      deps.resolveFfmpegBinaryPath ??
      (() => Promise.resolve(deps.ffmpegBinaryPath))
    const assertFfmpegAvailable = async () => {
      if (!(await resolveFfmpegBinaryPath())) {
        throw new BridgeReceiverError(
          'unsupported-kind',
          'ffmpeg is unavailable; configure it in Settings and retry'
        )
      }
    }
    this.coordinator = new MediaTaskCoordinator({
      mediaMetaStore: deps.mediaMetaStore,
      taskManager: deps.taskManager,
      activityRecorder: deps.activityRecorder,
      eventBus: deps.eventBus as {
        emit(event: string, payload: unknown): void
      },
      publishTaskUpdate: deps.publishTaskUpdate,
      publishTaskUpdateNow: deps.publishTaskUpdateNow,
      resolveFfmpegBinaryPath,
      pickName: deps.pickName,
      persist: deps.persistTask,
      persistTaskWithOccurrence: deps.persistTaskWithOccurrence,
      occurrenceDispatcher: deps.occurrenceDispatcher,
      parentTaskCreated: deps.parentTaskCreated,
      recordTransition: deps.recordTransition,
      runTaskMutation: deps.runTaskMutation,
      makeDownloader: (tmpDir) =>
        new SegmentDownloader({ aria2: deps.segmentAria2, tmpDir }),
      decryptor: new SegmentDecryptor(),
      assemble: assembleSegments,
      makeFfmpeg: () => new FfmpegService(),
      mkdtemp: async () => {
        await fs.promises.mkdir(deps.tmpRoot, { recursive: true })
        return fs.promises.mkdtemp(path.join(deps.tmpRoot, 'motrix-media-'))
      },
    })
    this.muxPipeline = new MuxPipeline({
      coordinator: this.coordinator,
      assertFfmpegAvailable,
    })
    this.hlsDashPipeline = new HlsDashPipeline({
      fetchManifest: deps.fetchManifest ?? fetchManifest,
      coordinator: this.coordinator,
      assertFfmpegAvailable,
    })
  }

  getMediaSegmentGids(taskId: string): string[] {
    return this.coordinator.getActiveSegmentGids(taskId)
  }

  cancelMedia(taskId: string): Promise<void> {
    return this.coordinator.cancel(taskId)
  }

  cancelActiveAndDrain(restart: () => Promise<void>): Promise<void> {
    return this.coordinator.cancelActiveAndDrain(restart)
  }

  stopAndDrain(): Promise<void> {
    return this.coordinator.stopAndDrain()
  }
}
