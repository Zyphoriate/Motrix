import { stripHopByHopHeaders } from '@core/bridge-receiver/header-replay'
import type { PluginHost } from '@core/plugin/host/plugin-host'
import {
  type PluginMediaResolution,
  PluginMediaResolutionSchema,
} from '@core/plugin/media-selection-service'
import { matchesAnyHostPermission } from '@core/plugin/permissions/host-pattern'
import type { PluginRegistry } from '@core/plugin/plugin-registry'
import { ErrorCodes, makeMdxpError } from '@motrix/mdxp'

// Resolved resources are a new request boundary, not a replay of page credentials.
const RESOURCE_HEADERS = new Set([
  'accept',
  'accept-language',
  'referer',
  'origin',
  'user-agent',
  'range',
])
export function resolvedMediaHeaders(
  headers: Record<string, string> = {}
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(stripHopByHopHeaders(headers)).filter(([name]) =>
      RESOURCE_HEADERS.has(name.toLowerCase())
    )
  )
}

/** Null means no provider claimed the URL. Claimed URLs never fall back to HTML. */
export function makePluginMediaResolver(
  registry: Pick<PluginRegistry, 'entries'>,
  host: Pick<PluginHost, 'activate' | 'invokeCommand'>
): (url: string, cookies?: string) => Promise<PluginMediaResolution | null> {
  return async (url, cookies) => {
    const candidates = registry
      .entries()
      .filter(
        (entry) =>
          entry.enabled &&
          entry.manifest.categories?.includes('site-resolver') &&
          entry.manifest.contributes.commands?.some(
            (command) =>
              command.public === true &&
              command.id === `${entry.manifest.id}.resolve`
          ) &&
          matchesAnyHostPermission(entry.manifest.hostPermissions, url)
      )
      .sort((a, b) =>
        a.origin === b.origin
          ? a.manifest.id.localeCompare(b.manifest.id)
          : a.origin === 'builtin'
            ? -1
            : 1
      )
    for (const entry of candidates) {
      const id = entry.manifest.id
      try {
        await host.activate(id)
        // Omit quality so the plugin uses its own configured preference.
        const raw = await host.invokeCommand(id, `${id}.resolve`, {
          url,
          ...(cookies ? { cookies } : {}),
        })
        const resolution = PluginMediaResolutionSchema.parse(raw)
        if (resolution.kind === 'direct') {
          if (resolution.directUrl === url) throw new Error('Unresolved page')
          return {
            ...resolution,
            headers: resolvedMediaHeaders(resolution.headers),
          }
        }
        return {
          ...resolution,
          video: {
            ...resolution.video,
            headers: resolvedMediaHeaders(resolution.video.headers),
          },
          audio: {
            ...resolution.audio,
            headers: resolvedMediaHeaders(resolution.audio.headers),
          },
        }
      } catch {
        // Try other eligible providers without leaking errors containing cookies
        // or signed resource URLs into the protocol response.
      }
    }
    if (candidates.length) {
      throw makeMdxpError(
        ErrorCodes.CapabilityNotSupported,
        'Media resolution failed; no download was created'
      )
    }
    return null
  }
}
