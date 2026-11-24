import { NOOP_TASK_ACTIVITY_RECORDER } from '@core/activity'
import type { PluginMediaTaskInput } from '@core/plugin/media-selection-service'
import type { CreateTaskDeps } from '@core/task/create-task-handler'
import { TaskManager } from '@core/task/task-manager'
import { describe, expect, it, vi } from 'vitest'
import { dispatchPluginMediaTask } from './plugin-media-dispatch'

vi.mock('@core/fs/ensure-directory', () => ({ ensureDirectory: vi.fn() }))

function input(): PluginMediaTaskInput {
  return {
    entry: {
      id: 'episode-1',
      title: 'Episode 1',
      url: 'https://example.test/watch/1',
    },
    resolution: {
      kind: 'mux',
      video: {
        url: 'https://video.test/v',
        headers: { Referer: 'https://example.test/', Connection: 'close' },
      },
      audio: {
        url: 'https://audio.test/a',
        headers: { Authorization: 'Bearer audio' },
      },
      container: 'mp4',
      title: 'Selected episode',
    },
    saveDir: '/requested',
    connections: 8,
    pluginId: 'resolver',
    requestId: 'fa9b3a9b-6b18-4a59-9882-4b53969806f7',
    source: 'bridge',
    sourceMeta: {
      kind: 'hls',
      extensionId: 'extension.test',
      browser: 'chromium',
      sessionKey: 'session',
      pageUrl: 'https://example.test/watch/1',
      pageTitle: 'Episode 1',
      qualityLabel: '1080p',
      durationSec: null,
      submittedAt: 1,
    },
  }
}

function deps() {
  return {
    adapter: {
      createDownload: vi.fn(async (params: { gid: string }) => params.gid),
    },
    taskManager: new TaskManager(),
    settingsManager: {
      getApp: () => ({ defaultSaveDir: '/default' }),
      getEngine: () => ({ maxConnectionPerServer: 16 }),
    },
    finalNamePicker: {
      pick: vi.fn(async (_dir: string, name: string) => name),
    },
    prepareSaveDir: vi.fn(async () => '/authorized'),
    dispatchMux: vi.fn(async (adapted: { taskId: string }) => ({
      taskId: adapted.taskId,
    })),
    publishTaskUpdate: vi.fn(),
    eventBus: { emit: vi.fn() },
    activityRecorder: NOOP_TASK_ACTIVITY_RECORDER,
    persistTask: vi.fn(async () => {}),
  } as unknown as CreateTaskDeps
}

describe('dispatchPluginMediaTask', () => {
  it('authorizes the directory before mux dispatch and preserves separate stream headers and media name', async () => {
    const host = deps()
    const taskId = await dispatchPluginMediaTask(input(), host)
    expect(host.prepareSaveDir).toHaveBeenCalledWith('/requested')
    expect(host.dispatchMux).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId,
        saveDir: '/authorized',
        finalName: 'Selected episode.mp4',
        videoUrl: 'https://video.test/v',
        audioUrl: 'https://audio.test/a',
        videoHeaders: { Referer: 'https://example.test/' },
        audioHeaders: { Authorization: 'Bearer audio' },
        sourceMeta: input().sourceMeta,
      })
    )
    expect(host.adapter.createDownload).not.toHaveBeenCalled()
  })

  it('refuses unauthorized output without dispatching any media or engine task', async () => {
    const host = deps()
    vi.mocked(host.prepareSaveDir!).mockRejectedValue(
      new Error('directory denied')
    )
    await expect(dispatchPluginMediaTask(input(), host)).rejects.toThrow(
      'directory denied'
    )
    expect(host.dispatchMux).not.toHaveBeenCalled()
    expect(host.adapter.createDownload).not.toHaveBeenCalled()
  })

  it('never falls back to downloading the page when mux dispatch fails', async () => {
    const host = deps()
    vi.mocked(host.dispatchMux!).mockRejectedValue(
      new Error('ffmpeg unavailable')
    )
    await expect(dispatchPluginMediaTask(input(), host)).rejects.toThrow(
      'ffmpeg unavailable'
    )
    expect(host.adapter.createDownload).not.toHaveBeenCalled()
  })

  it('submits direct resolution URL with its own headers and persists the created task', async () => {
    const host = deps()
    const selected = input()
    selected.resolution = {
      kind: 'direct',
      directUrl: 'https://cdn.test/episode.mp4',
      headers: { Referer: 'https://example.test/' },
    }
    const taskId = await dispatchPluginMediaTask(selected, host)
    expect(host.adapter.createDownload).toHaveBeenCalledWith(
      expect.objectContaining({
        uris: ['https://cdn.test/episode.mp4'],
        saveDir: '/authorized',
        connections: 8,
        filename: 'Episode 1.mp4.motrix',
        headers: { Referer: 'https://example.test/' },
      })
    )
    expect(host.persistTask).toHaveBeenCalledWith(
      expect.objectContaining({ id: taskId })
    )
    expect(host.dispatchMux).not.toHaveBeenCalled()
  })
})
