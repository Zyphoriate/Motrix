import { NotificationCenter } from '@core/notifications/notification-center'
import { MotrixDatabase } from '@core/session/motrix-database'
import { Commands } from '@shared/protocol/commands'
import { Queries } from '@shared/protocol/queries'
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

  it('awaits pending cancellation before deleting a media choice and preserves it on failure', async () => {
    notificationCenter.notify({
      sourceKey: 'pending',
      kind: 'media-selection-required',
      severity: 'warning',
      titleKey: 'title',
      taskId: 'pending-task',
    })
    const row = notificationCenter.list()[0]
    const cancel = vi.fn<() => Promise<void>>(async () => {
      expect(notificationCenter.get(row.id)).not.toBeNull()
      throw new Error('cancel failed')
    })
    const handlers = buildNotificationHandlers({
      notificationCenter,
      getPendingMediaSelection: () => ({ list: vi.fn(), cancel }),
    })
    await expect(
      handlers[Commands.DeleteNotification]?.(row.id)
    ).rejects.toThrow('cancel failed')
    expect(notificationCenter.get(row.id)).not.toBeNull()
    cancel.mockImplementation(async () => {})
    await expect(handlers[Commands.DeleteNotification]?.(row.id)).resolves.toBe(
      true
    )
    expect(cancel).toHaveBeenCalledWith('pending-task')
  })

  it('cancels every pending choice before clearing and retains notifications on cancellation failure', async () => {
    notificationCenter.notify({
      sourceKey: 'ordinary',
      kind: 'task-error',
      severity: 'error',
      titleKey: 'title',
    })
    const cancel = vi
      .fn()
      .mockRejectedValueOnce(new Error('cancel failed'))
      .mockResolvedValue(undefined)
    const list = vi
      .fn()
      .mockReturnValue([{ taskId: 'first' }, { taskId: 'second' }])
    const handlers = buildNotificationHandlers({
      notificationCenter,
      getPendingMediaSelection: () => ({ list, cancel }),
    })
    await expect(handlers[Commands.ClearNotifications]?.()).rejects.toThrow(
      'cancel failed'
    )
    expect(notificationCenter.list()).toHaveLength(1)
    await expect(handlers[Commands.ClearNotifications]?.()).resolves.toBe(1)
    expect(cancel.mock.calls.map(([id]) => id)).toEqual([
      'first',
      'first',
      'second',
    ])
  })

  it('registers and removes exactly the 7 notification channels', () => {
    const dispose = registerNotificationIpc({ notificationCenter })

    expect(handle).toHaveBeenCalledTimes(7)
    dispose()
    expect(removeHandler).toHaveBeenCalledTimes(7)
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
