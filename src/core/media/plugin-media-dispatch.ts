import { stripHopByHopHeaders } from '@core/bridge-receiver/header-replay'
import { ensureMediaExtension } from '@core/bridge-receiver/pipelines/media-final-name'
import { sanitizeFilename } from '@core/bridge-receiver/submit-download-adapter'
import type { PluginMediaTaskInput } from '@core/plugin/media-selection-service'
import {
  type CreateTaskDeps,
  handleCreateTask,
} from '@core/task/create-task-handler'
import { AppError, ErrorCode } from '@shared/errors'

/** Submit a resolved selection through the host's admission and persistence path. */
export async function dispatchPluginMediaTask(
  input: PluginMediaTaskInput,
  deps: CreateTaskDeps
): Promise<string> {
  const { entry, resolution, saveDir, connections } = input
  const title = sanitizeFilename(resolution.title || entry.title).trim()
  const directExtension =
    resolution.kind === 'direct'
      ? /\.(mp4|mkv|webm|mov|m4v|ts|flv|m4a|aac|mp3|opus)$/i.exec(
          new URL(resolution.directUrl).pathname
        )?.[0]
      : undefined
  const directFilename =
    directExtension &&
    !/\.(mp4|mkv|webm|mov|m4v|ts|flv|m4a|aac|mp3|opus)$/i.test(title)
      ? `${title}${directExtension}`
      : title
  if (resolution.kind === 'mux' && !deps.dispatchMux) {
    throw new AppError(
      ErrorCode.EngineFeatureUnavailable,
      'settings.integration.media.pipelineUnavailable'
    )
  }
  const dispatchMux = deps.dispatchMux
  const result = await handleCreateTask(
    {
      type: 'http',
      uris: [resolution.kind === 'direct' ? resolution.directUrl : entry.url],
      saveDir,
      connections,
      ...(title
        ? {
            filename:
              resolution.kind === 'mux'
                ? ensureMediaExtension(title, resolution.container)
                : directFilename,
          }
        : {}),
      headers:
        resolution.kind === 'direct'
          ? Object.entries(stripHopByHopHeaders(resolution.headers ?? {})).map(
              ([name, value]) => ({ name, value })
            )
          : [],
    },
    {
      ...deps,
      // The selected command already resolved the resource at submit time;
      // the pre-resolve seam must not run a second resolver for this URL.
      orchestrator: undefined,
      resolveToMux:
        resolution.kind === 'mux'
          ? async () => ({
              videoUrl: resolution.video.url,
              audioUrl: resolution.audio.url,
              container: resolution.container,
              title,
            })
          : undefined,
      dispatchMux:
        resolution.kind === 'mux' && dispatchMux
          ? (adapted) =>
              dispatchMux({
                ...adapted,
                videoHeaders: stripHopByHopHeaders(
                  resolution.video.headers ?? {}
                ),
                audioHeaders: stripHopByHopHeaders(
                  resolution.audio.headers ?? {}
                ),
              })
          : undefined,
    }
  )
  return result.taskId
}
