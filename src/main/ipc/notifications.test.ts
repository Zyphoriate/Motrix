import { NotificationCenter } from '@core/notifications/notification-center'
import { PendingMediaSelectionService } from '@core/plugin/pending-media-selection-service'
import { MotrixDatabase } from '@core/session/motrix-database'
import { TaskManager } from '@core/task/task-manager'
import { Commands } from '@shared/protocol/commands'
import { Queries } from '@shared/protocol/queries'
import type { MediaSelectionPreview } from '@shared/schemas/plugin-media-selection'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { handle, removeHandler } = vi.hoisted(() => ({
  handle: vi.fn(),
  removeHandler: vi.fn(),
}))

vi.mock('electron', () => ({
  ipcMain: { handle, removeHandler },
}))

vi.mock('./trusted-ipc', () => ({
  registerTrustedIpcHandler: (
    channel: string,
    listener: (...args: unknown[]) => unknown
  ) => handle(channel, listener),
}))

import {
  buildNotificationHandlers,
  registerNotificationIpc,
} from './notifications'

function makeLog() {
  return { warn: vi.fn(), error: vi.fn() }
}

describe('notification center IPC (main)', () => {
  let db: MotrixDatabase
  let notificationCenter: NotificationCenter

  beforeEach(() => {
    vi.clearAllMocks()
    db = new MotrixDatabase(':memory:')
    db.init()
    notificationCenter = new NotificationCenter({
      store: db,
      emit: vi.fn(),
      log: makeLog(),
    })
  })

  afterEach(() => {
    db.close()
  })

  it('ListNotifications and GetUnreadNotificationCount round-trip against a real center', async () => {
    notificationCenter.notify({
      sourceKey: 'src-1',
      kind: 'task-error',
      severity: 'error',
      titleKey: 'notification.title',
    })
    const handlers = buildNotificationHandlers({ notificationCenter })

    const list = await handlers[Queries.ListNotifications]?.()
    expect(list).toHaveLength(1)
    await expect(
      handlers[Queries.GetUnreadNotificationCount]?.()
    ).resolves.toBe(1)
  })

  it('MarkNotificationRead marks the row read and clears the unread count', async () => {
    notificationCenter.notify({
      sourceKey: 'src-1',
      kind: 'task-error',
      severity: 'error',
      titleKey: 'notification.title',
    })
    const [row] = notificationCenter.list()
    const handlers = buildNotificationHandlers({ notificationCenter })

    await expect(
      handlers[Commands.MarkNotificationRead]?.(row?.id)
    ).resolves.toBe(true)
    await expect(
      handlers[Queries.GetUnreadNotificationCount]?.()
    ).resolves.toBe(0)
  })

  it('MarkAllNotificationsRead marks every unread row', async () => {
    notificationCenter.notify({
      sourceKey: 'src-1',
      kind: 'task-error',
      severity: 'error',
      titleKey: 'notification.title',
    })
    notificationCenter.notify({
      sourceKey: 'src-2',
      kind: 'task-error',
      severity: 'error',
      titleKey: 'notification.title',
    })
    const handlers = buildNotificationHandlers({ notificationCenter })

    await expect(handlers[Commands.MarkAllNotificationsRead]?.()).resolves.toBe(
      2
    )
    await expect(
      handlers[Queries.GetUnreadNotificationCount]?.()
    ).resolves.toBe(0)
  })

  it('DeleteNotification removes the row from the list', async () => {
    notificationCenter.notify({
      sourceKey: 'src-1',
      kind: 'task-error',
      severity: 'error',
      titleKey: 'notification.title',
    })
    const [row] = notificationCenter.list()
    const handlers = buildNotificationHandlers({ notificationCenter })

    await expect(
      handlers[Commands.DeleteNotification]?.(row?.id)
    ).resolves.toBe(true)
    await expect(handlers[Queries.ListNotifications]?.()).resolves.toEqual([])
  })

  it('ClearNotifications empties the list', async () => {
    notificationCenter.notify({
      sourceKey: 'src-1',
      kind: 'task-error',
      severity: 'error',
      titleKey: 'notification.title',
    })
    const handlers = buildNotificationHandlers({ notificationCenter })

    await expect(handlers[Commands.ClearNotifications]?.()).resolves.toBe(1)
    await expect(handlers[Queries.ListNotifications]?.()).resolves.toEqual([])
  })

  it('clears ordinary rows, including read rows beyond the default page, and retains media choices', async () => {
    notificationCenter.notify({
      sourceKey: 'pending',
      kind: 'media-selection-required',
      severity: 'warning',
      titleKey: 'title',
      taskId: 'pending-task',
    })
    for (let index = 0; index < 110; index++) {
      notificationCenter.notify({
        sourceKey: `ordinary-${index}`,
        kind: 'task-error',
        severity: 'error',
        titleKey: 'title',
      })
    }
    notificationCenter.markRead(notificationCenter.list()[0].id)
    const handlers = buildNotificationHandlers({ notificationCenter })
    await expect(
      handlers[Commands.ClearOrdinaryNotifications]?.()
    ).resolves.toBe(110)
    expect(notificationCenter.list()).toEqual([
      expect.objectContaining({ kind: 'media-selection-required' }),
    ])
  })

  it.each([Commands.DeleteNotification, Commands.ClearNotifications])(
    '%s removes notifications and preserves the durable choice and task',
    async (command) => {
      const taskManager = new TaskManager()
      const preview: MediaSelectionPreview = {
        selectionId: 'fa9b3a9b-6b18-4a59-9882-4b53969806f7',
        pluginId: 'community.media-resolver',
        title: 'Multipart video',
        entries: [
          { id: 'part1', title: 'First', url: 'https://example.com/video?p=1' },
          {
            id: 'part2',
            title: 'Second',
            url: 'https://example.com/video?p=2',
          },
        ],
        qualities: ['1080p'],
        defaultQuality: '1080p',
        expiresAt: Date.now() + 600_000,
      }
      const pending = new PendingMediaSelectionService({
        db,
        taskManager,
        mediaSelection: {
          inspect: vi.fn(async () => preview),
          create: vi.fn(),
        },
      })
      const receipt = await pending.enqueue({
        url: 'https://example.com/video',
        saveDir: '/downloads',
      })
      notificationCenter.notify({
        sourceKey: 'pending',
        kind: 'media-selection-required',
        severity: 'warning',
        titleKey: 'title',
        taskId: receipt.taskId,
      })
      const row = notificationCenter.list()[0]
      const cancel = vi.spyOn(pending, 'cancel')
      const handlers = buildNotificationHandlers({ notificationCenter })

      await handlers[command]?.(row.id)

      expect(notificationCenter.list()).toEqual([])
      expect(cancel).not.toHaveBeenCalled()
      expect(pending.list()).toMatchObject([receipt])
      expect(pending.getRecord(receipt.requestId)).toMatchObject({
        ...receipt,
        state: 'pending',
      })
      expect(db.getTask(receipt.taskId)).not.toBeNull()
      expect(taskManager.getById(receipt.taskId)).toBeDefined()
      await expect(pending.get(receipt.requestId)).resolves.toEqual(preview)
    }
  )

  it('lists all media notification task IDs, including read rows beyond the default page', async () => {
    const expected: string[] = []
    for (let index = 0; index < 110; index++) {
      const taskId = `pending-${index}`
      expected.push(taskId)
      notificationCenter.notify({
        sourceKey: taskId,
        kind: 'media-selection-required',
        severity: 'warning',
        titleKey: 'title',
        taskId,
      })
    }
    notificationCenter.markAllRead()
    notificationCenter.notify({
      sourceKey: 'no-task',
      kind: 'media-selection-required',
      severity: 'warning',
      titleKey: 'title',
    })
    notificationCenter.notify({
      sourceKey: 'ordinary',
      kind: 'task-error',
      severity: 'error',
      titleKey: 'title',
      taskId: 'ordinary-task',
    })
    const handlers = buildNotificationHandlers({ notificationCenter })
    expect(notificationCenter.list()).toHaveLength(100)
    await expect(
      handlers[Queries.ListPendingMediaNotificationTaskIds]?.()
    ).resolves.toEqual(expected.sort())
    await handlers[Commands.ClearNotifications]?.()
    await expect(
      handlers[Queries.ListPendingMediaNotificationTaskIds]?.()
    ).resolves.toEqual([])
  })

  it('registers and removes exactly the 8 notification channels', () => {
    const dispose = registerNotificationIpc({ notificationCenter })

    expect(handle).toHaveBeenCalledTimes(8)
    dispose()
    expect(removeHandler).toHaveBeenCalledTimes(8)
  })

  it('routes handler invocations through trackAsyncWork when provided', async () => {
    const spy = vi.fn()
    registerNotificationIpc({
      notificationCenter,
      trackAsyncWork: <T>(operation: () => Promise<T>) => {
        spy()
        return operation()
      },
    })

    const registeredCall = handle.mock.calls.find(
      ([channel]) => channel === Queries.ListNotifications
    )
    const wrapper = registeredCall?.[1] as
      | ((event: unknown, ...args: unknown[]) => Promise<unknown>)
      | undefined

    const result = await wrapper?.({})

    expect(spy).toHaveBeenCalledTimes(1)
    expect(result).toEqual([])
  })

  it('still invokes the handler when trackAsyncWork is not provided', async () => {
    registerNotificationIpc({ notificationCenter })

    const registeredCall = handle.mock.calls.find(
      ([channel]) => channel === Queries.ListNotifications
    )
    const wrapper = registeredCall?.[1] as
      | ((event: unknown, ...args: unknown[]) => Promise<unknown>)
      | undefined

    const result = await wrapper?.({})

    expect(result).toEqual([])
  })
})
