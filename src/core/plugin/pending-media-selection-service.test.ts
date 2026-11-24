import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { MotrixDatabase } from '@core/session/motrix-database'
import { scopedCreateRequestId } from '@core/task/create-request-id'
import { TaskManager } from '@core/task/task-manager'
import { taskRowToDownloadTask } from '@core/task/task-row-to-download-task'
import { isPendingMediaSelectionTask } from '@shared/schemas/pending-media-selection'
import type { MediaSelectionPreview } from '@shared/schemas/plugin-media-selection'
import { TaskStatus } from '@shared/types/task'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PendingMediaSelectionService } from './pending-media-selection-service'

const url = 'https://www.bilibili.com/video/BV1GJ411x7h7'
const preview: MediaSelectionPreview = {
  selectionId: 'fa9b3a9b-6b18-4a59-9882-4b53969806f7',
  pluginId: 'community.bilibili-resolver',
  title: 'Multipart video',
  entries: [
    { id: 'part1', title: 'First', url: `${url}?p=1`, partNumber: 1 },
    { id: 'part2', title: 'Second', url: `${url}?p=2`, partNumber: 2 },
  ],
  qualities: ['1080p', '720p'],
  defaultQuality: '1080p',
  expiresAt: Date.now() + 600_000,
}
const databases: MotrixDatabase[] = []
const directories: string[] = []
afterEach(() => {
  for (const db of databases.splice(0)) db.close()
  for (const directory of directories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true })
})
function setup(filename = ':memory:', clock = { value: 1_000_000 }) {
  const db = new MotrixDatabase(filename)
  db.init()
  databases.push(db)
  const taskManager = new TaskManager()
  const inspect = vi.fn(async () => structuredClone(preview))
  const create = vi.fn(
    async (
      input: { entryIds: string[] },
      _options?: { requestId?: string }
    ) => ({
      created: input.entryIds.map((entryId) => ({
        entryId,
        taskId: `download-${entryId}`,
      })),
      failed: [] as { entryId: string; message: string }[],
    })
  )
  const onChange = vi.fn()
  const service = new PendingMediaSelectionService({
    db,
    taskManager,
    mediaSelection: { inspect, create },
    now: () => clock.value,
    onChange,
  })
  return { db, taskManager, inspect, create, service, onChange, clock }
}
const enqueue = (h: ReturnType<typeof setup>, extra = {}) =>
  h.service.enqueue({ url, saveDir: '/downloads', ...extra })
const confirm = (
  h: ReturnType<typeof setup>,
  requestId: string,
  entryIds = ['part1', 'part2']
) => h.service.confirm({ requestId, entryIds, quality: '1080p' })

describe('durable pending media selection', () => {
  it('registers a genuine waiting task without dispatching and restores the marker', async () => {
    const h = setup()
    const receipt = await enqueue(h)
    const parent = h.taskManager.getById(receipt.taskId)!
    expect(parent).toMatchObject({
      status: TaskStatus.MetadataReady,
      engineTaskId: '',
      diskPath: '',
      finalPath: '',
      pendingMediaSelection: { requestId: receipt.requestId },
    })
    expect(parent.instances[0]).toMatchObject({
      gid: null,
      diskPath: '',
      payload: { pendingMediaSelection: receipt.requestId },
    })
    expect(h.create).not.toHaveBeenCalled()
    const pair = h.db.getTask(receipt.taskId)!
    expect(
      isPendingMediaSelectionTask(
        taskRowToDownloadTask(pair.task, pair.instances)
      )
    ).toBe(true)
  })

  it('reopens durable queue and refreshes the preview rather than replaying an expired session', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pending-media-'))
    directories.push(directory)
    const filename = path.join(directory, 'motrix.db')
    const first = setup(filename)
    const receipt = await enqueue(first)
    first.db.close()
    databases.splice(databases.indexOf(first.db), 1)
    const second = setup(filename)
    expect(second.service.list()).toMatchObject([
      { ...receipt, title: preview.title, saveDir: '/downloads' },
    ])
    expect(await second.service.get(receipt.requestId)).toEqual(preview)
    expect(second.inspect).toHaveBeenCalledWith({ url })
    expect(second.create).not.toHaveBeenCalled()
  })

  it('deduplicates simultaneous enqueue and repeated confirmation by two UIs', async () => {
    const h = setup()
    const [a, b] = await Promise.all([
      enqueue(h, { dedupKey: 'bridge-session-key' }),
      enqueue(h, { dedupKey: 'bridge-session-key' }),
    ])
    expect(a).toEqual(b)
    const [first, second] = await Promise.all([
      confirm(h, a.requestId),
      confirm(h, a.requestId),
    ])
    expect(first).toEqual(second)
    expect(h.create).toHaveBeenCalledTimes(2)
    expect(h.create.mock.calls[0][1]).toMatchObject({
      requestId: a.requestId,
      source: 'user',
      sourceMeta: null,
    })
    expect(h.service.list()).toEqual([])
    expect(h.db.getTask(a.taskId)).toBeNull()
    expect(h.taskManager.getById(a.taskId)).toBeUndefined()
    expect(h.service.getChildTaskIds(a.taskId)).toEqual([
      'download-part1',
      'download-part2',
    ])
    expect(h.onChange).toHaveBeenLastCalledWith({ ...a, state: 'settled' })
  })

  it('persists partial success and retries only the failed part', async () => {
    const h = setup()
    const receipt = await enqueue(h)
    h.create.mockImplementationOnce(async () => ({
      created: [{ entryId: 'part1', taskId: 'download-part1' }],
      failed: [],
    }))
    h.create.mockImplementationOnce(async () => ({
      created: [],
      failed: [{ entryId: 'part2', message: 'Retry' }],
    }))
    const first = await confirm(h, receipt.requestId)
    expect(first.failed).toHaveLength(1)
    expect(h.service.list()).toHaveLength(1)
    expect(h.service.getRecord(receipt.requestId)?.created).toEqual({
      part1: 'download-part1',
    })
    expect(
      (await h.service.get(receipt.requestId))?.entries.map((entry) => entry.id)
    ).toEqual(['part2'])
    const second = await confirm(h, receipt.requestId)
    expect(second.created).toHaveLength(2)
    expect(h.create).toHaveBeenCalledTimes(3)
    expect(h.create.mock.calls[2][0].entryIds).toEqual(['part2'])
  })

  it('recovers a child receipt committed just before a crash before resolving again', async () => {
    const h = setup()
    const receipt = await enqueue(h)
    const pair = h.db.getTask(receipt.taskId)!
    const child = taskRowToDownloadTask(pair.task, pair.instances)
    child.id = 'already-created'
    child.instances = [
      {
        ...child.instances[0],
        motrixId: child.id,
        payload: {
          createRequestId: scopedCreateRequestId(receipt.requestId, 'part1'),
        },
      },
    ]
    h.taskManager.set(child.id, child)
    const result = await confirm(h, receipt.requestId, ['part1'])
    expect(result.created).toEqual([{ entryId: 'part1', taskId: child.id }])
    expect(h.create).not.toHaveBeenCalled()
    expect(h.inspect).toHaveBeenCalledTimes(1)
  })

  it('emits a preview error transition once rather than on every UI refresh', async () => {
    const h = setup()
    const receipt = await enqueue(h)
    h.onChange.mockClear()
    h.inspect.mockRejectedValue(new Error('provider unavailable'))
    await expect(h.service.get(receipt.requestId)).rejects.toThrow(
      'Media preview needs attention'
    )
    await expect(h.service.get(receipt.requestId)).rejects.toThrow(
      'Media preview needs attention'
    )
    expect(h.onChange).toHaveBeenCalledTimes(1)
    expect(h.onChange).toHaveBeenCalledWith({ ...receipt, state: 'pending' })
  })

  it('retains a pending selection when the original provider is revoked', async () => {
    const h = setup()
    const receipt = await enqueue(h)
    h.inspect.mockResolvedValueOnce({
      ...preview,
      pluginId: 'another.provider',
    })
    await expect(confirm(h, receipt.requestId)).rejects.toThrow(
      'Media preview needs attention'
    )
    expect(h.service.list()[0].lastError).toBeDefined()
    expect(h.create).not.toHaveBeenCalled()
    expect(h.db.getTask(receipt.taskId)).not.toBeNull()
  })

  it('cancels the real parent by task ID, retains receipts and never dispatches', async () => {
    const h = setup()
    const receipt = await enqueue(h)
    await h.service.cancel(receipt.taskId)
    expect(h.service.list()).toEqual([])
    expect(h.db.getTask(receipt.taskId)).toBeNull()
    await expect(confirm(h, receipt.requestId)).rejects.toThrow('removed')
    expect(h.create).not.toHaveBeenCalled()
  })

  it('marks cancellation without deleting the parent when removal owns the persistence barrier', async () => {
    const h = setup()
    const receipt = await enqueue(h)
    expect(receipt.requestId).toBe(receipt.taskId)
    await h.service.cancel(receipt.taskId, { deleteParent: false })
    expect(h.service.list()).toEqual([])
    expect(h.db.getTask(receipt.taskId)).not.toBeNull()
    expect(h.taskManager.getById(receipt.taskId)).toBeDefined()
    expect(await h.service.get(receipt.requestId)).toBeNull()
  })

  it('requires encryption for supplied cookies', async () => {
    const h = setup()
    await expect(enqueue(h, { cookies: 'private-cookie' })).rejects.toThrow(
      'Encrypted cookie storage'
    )
    expect(h.db.getAllTasks()).toEqual([])
  })

  it('expires pending entries, frees queue capacity, and removes only their metadata task', async () => {
    const h = setup()
    const receipt = await enqueue(h)
    h.clock.value += 8 * 24 * 60 * 60_000
    expect(h.service.list()).toEqual([])
    expect(h.db.getTask(receipt.taskId)).toBeNull()
    expect(h.taskManager.getById(receipt.taskId)).toBeUndefined()
    expect(h.onChange).toHaveBeenLastCalledWith({
      ...receipt,
      state: 'cancelled',
    })
    await expect(h.service.get(receipt.requestId)).resolves.toBeNull()
    expect(h.service.getRecord(receipt.requestId)?.state).toBe('cancelled')
    expect(h.create).not.toHaveBeenCalled()
  })

  it('stores only encrypted cookies when an encryption adapter is supplied', async () => {
    const h = setup()
    const service = new PendingMediaSelectionService({
      db: h.db,
      taskManager: h.taskManager,
      mediaSelection: { inspect: h.inspect, create: h.create },
      encrypt: () => 'sealed-cookie',
      decrypt: () => 'secret-cookie',
    })
    const receipt = await service.enqueue({
      url,
      saveDir: '/downloads',
      cookies: 'secret-cookie',
    })
    const stored = service.getRecord(receipt.requestId)
    expect(stored?.encryptedCookies).toBe('sealed-cookie')
    expect(JSON.stringify(stored)).not.toContain('secret-cookie')
    expect(JSON.stringify(stored)).not.toContain('resolution')
    await service.confirm({
      requestId: receipt.requestId,
      entryIds: ['part1'],
      quality: '1080p',
    })
    expect(h.create.mock.calls[0][1]).toMatchObject({
      requestId: receipt.requestId,
      cookies: 'secret-cookie',
      source: 'user',
      sourceMeta: null,
    })
  })
})
