import { describe, expect, it, vi } from 'vitest'
import { PluginMediaSelectionService } from './media-selection-service'

const pluginId = 'community.bilibili-resolver'
const source = 'https://www.bilibili.com/video/BV1GJ411x7h7'
const collection = {
  schemaVersion: 1,
  title: 'Video',
  entries: [
    {
      id: 'cid-1',
      title: 'Video - P1 First',
      url: `${source}?p=1`,
      partNumber: 1,
    },
    {
      id: 'cid-2',
      title: 'Video - P2 Second',
      url: `${source}?p=2`,
      partNumber: 2,
    },
  ],
  qualities: ['1080p', '720p', '480p'],
  defaultQuality: '1080p',
}
const resolution = {
  kind: 'mux',
  container: 'mp4',
  title: 'Video',
  video: {
    url: 'https://video.example/video.m4s',
    headers: { Referer: source },
  },
  audio: {
    url: 'https://audio.example/audio.m4s',
    headers: { Referer: source },
  },
}
function setup() {
  let now = 1_000_000
  const policy = { enabled: true, generation: 1, executableDigest: 'digest-v1' }
  const entries = [
    {
      enabled: true,
      executableDigest: 'digest-v1',
      origin: 'community',
      manifest: {
        id: pluginId,
        categories: ['site-resolver'],
        hostPermissions: ['https://*.bilibili.com/*'],
        contributes: {
          commands: [
            { id: `${pluginId}.inspectMedia`, public: true },
            { id: `${pluginId}.resolve`, public: true },
          ],
        },
      },
    },
  ]
  const invokeCommand = vi.fn<
    (id: string, command: string, args: unknown) => Promise<unknown>
  >(async (_id, command) =>
    command.endsWith('.inspectMedia') ? collection : resolution
  )
  const createTask = vi.fn(
    async ({ entry }: { entry: { id: string } }) => `task-${entry.id}`
  )
  const service = new PluginMediaSelectionService({
    registry: { entries: () => entries, policySnapshot: () => policy } as never,
    host: { activate: vi.fn(async () => undefined), invokeCommand } as never,
    createTask,
    now: () => now,
  })
  return {
    service,
    invokeCommand,
    createTask,
    entries,
    policy,
    expire: () => {
      now += 11 * 60_000
    },
  }
}
async function previewAndRequest(h: ReturnType<typeof setup>) {
  const preview = await h.service.inspect({ url: source })
  expect(preview).not.toBeNull()
  return {
    selectionId: preview!.selectionId,
    entryIds: ['cid-1', 'cid-2'],
    quality: '1080p',
    saveDir: '/downloads',
  }
}

describe('plugin media selections', () => {
  it('only inspects supported pages and creates no tasks before confirmation', async () => {
    const h = setup()
    expect(
      await h.service.inspect({ url: 'https://unrelated.example/file.zip' })
    ).toBeNull()
    expect(h.invokeCommand).not.toHaveBeenCalled()
    const preview = await h.service.inspect({ url: source })
    expect(preview).toMatchObject({
      title: 'Video',
      entries: collection.entries,
      defaultQuality: '1080p',
    })
    expect(h.createTask).not.toHaveBeenCalled()
    expect(h.invokeCommand.mock.calls).toHaveLength(1)
  })

  it('resolves only selected parts at submit time with the selected quality', async () => {
    const h = setup()
    const request = await previewAndRequest(h)
    const result = await h.service.create({
      ...request,
      entryIds: ['cid-2'],
      quality: '720p',
    })
    expect(result).toEqual({
      created: [{ entryId: 'cid-2', taskId: 'task-cid-2' }],
      failed: [],
    })
    expect(h.invokeCommand).toHaveBeenLastCalledWith(
      pluginId,
      `${pluginId}.resolve`,
      { url: `${source}?p=2`, quality: '720p' }
    )
    expect(h.createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        entry: collection.entries[1],
        resolution,
        saveDir: '/downloads',
      })
    )
  })

  it('rejects forged entry ids without resolving or downloading', async () => {
    const h = setup()
    const request = await previewAndRequest(h)
    await expect(
      h.service.create({ ...request, entryIds: ['forged'] })
    ).rejects.toThrow('Unknown')
    expect(h.invokeCommand).toHaveBeenCalledTimes(1)
    expect(h.createTask).not.toHaveBeenCalled()
  })

  it('rejects empty and duplicate selections', async () => {
    const h = setup()
    const request = await previewAndRequest(h)
    await expect(
      h.service.create({ ...request, entryIds: [] })
    ).rejects.toThrow()
    await expect(
      h.service.create({ ...request, entryIds: ['cid-1', 'cid-1'] })
    ).rejects.toThrow()
    expect(h.createTask).not.toHaveBeenCalled()
  })

  it('rejects expired receipts', async () => {
    const h = setup()
    const request = await previewAndRequest(h)
    h.expire()
    await expect(h.service.create(request)).rejects.toThrow('expired')
    expect(h.createTask).not.toHaveBeenCalled()
  })

  it.each(['enabled', 'generation', 'executableDigest'] as const)(
    'does not submit stale provider policy: %s',
    async (field) => {
      const h = setup()
      const request = await previewAndRequest(h)
      if (field === 'enabled') h.policy.enabled = false
      if (field === 'generation') h.policy.generation += 1
      if (field === 'executableDigest') h.policy.executableDigest = 'changed'
      const result = await h.service.create(request)
      expect(result.failed).toHaveLength(2)
      expect(h.createTask).not.toHaveBeenCalled()
    }
  )

  it('deduplicates simultaneous submissions and retries', async () => {
    const h = setup()
    const request = await previewAndRequest(h)
    const [first, second] = await Promise.all([
      h.service.create(request),
      h.service.create(request),
    ])
    expect(first).toEqual(second)
    expect(h.createTask).toHaveBeenCalledTimes(2)
    expect(await h.service.create(request)).toEqual(first)
    expect(h.createTask).toHaveBeenCalledTimes(2)
  })

  it('retries only failed parts and retains successful task identities', async () => {
    const h = setup()
    const request = await previewAndRequest(h)
    h.createTask
      .mockImplementationOnce(async () => 'task-first')
      .mockRejectedValueOnce(new Error('disk unavailable'))
    const first = await h.service.create(request)
    expect(first.created).toEqual([{ entryId: 'cid-1', taskId: 'task-first' }])
    expect(first.failed).toHaveLength(1)
    const retry = await h.service.create(request)
    expect(retry.created).toEqual([
      { entryId: 'cid-1', taskId: 'task-first' },
      { entryId: 'cid-2', taskId: 'task-cid-2' },
    ])
    expect(h.createTask).toHaveBeenCalledTimes(3)
  })

  it('rejects provider pages outside declared hosts', async () => {
    const h = setup()
    h.invokeCommand.mockResolvedValueOnce({
      ...collection,
      entries: [
        { ...collection.entries[0], url: 'https://outside.example/page' },
      ],
    })
    await expect(h.service.inspect({ url: source })).rejects.toThrow(
      'undeclared'
    )
    expect(h.createTask).not.toHaveBeenCalled()
  })

  it('rejects malformed mux output and never falls back to the HTML page', async () => {
    const h = setup()
    const request = await previewAndRequest(h)
    h.invokeCommand.mockResolvedValue({
      kind: 'mux',
      video: { url: 'https://video.example/only.m4s' },
    })
    const result = await h.service.create(request)
    expect(result.created).toHaveLength(0)
    expect(result.failed).toHaveLength(2)
    expect(h.createTask).not.toHaveBeenCalled()
  })

  it('rejects credentials and CRLF headers without leaking provider errors', async () => {
    const h = setup()
    await expect(
      h.service.inspect({ url: 'https://user:secret@www.bilibili.com/video/x' })
    ).rejects.toThrow()
    const request = await previewAndRequest(h)
    h.invokeCommand.mockResolvedValue({
      ...resolution,
      audio: {
        url: 'https://audio.example/a',
        headers: { Cookie: 'secret\r\nInjected: value' },
      },
    })
    const result = await h.service.create(request)
    expect(result.failed).toHaveLength(2)
    expect(JSON.stringify(result)).not.toContain('secret')
    expect(h.createTask).not.toHaveBeenCalled()
  })
})
