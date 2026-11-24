import type { NotificationCenter } from '@core/notifications/notification-center'
import type { PendingMediaSelectionService } from '@core/plugin/pending-media-selection-service'
import { Commands } from '@shared/protocol/commands'
import type { Handler } from '@shared/protocol/handler-types'
import { Queries } from '@shared/protocol/queries'
import { ipcMain } from 'electron'
import { registerTrustedIpcHandler } from './trusted-ipc'

export interface NotificationIpcDeps {
  notificationCenter: Pick<
    NotificationCenter,
    | 'list'
    | 'get'
    | 'unreadCount'
    | 'markRead'
    | 'markAllRead'
    | 'delete'
    | 'clear'
    | 'clearOrdinary'
  >
  getPendingMediaSelection?: () => Pick<
    PendingMediaSelectionService,
    'list' | 'cancel'
  >
  trackAsyncWork?: <T>(operation: () => Promise<T>) => Promise<T>
}

export function buildNotificationHandlers(
  deps: NotificationIpcDeps
): Record<string, Handler> {
  const { notificationCenter } = deps

  return {
    [Queries.ListNotifications]: async () => notificationCenter.list(),
    [Queries.GetUnreadNotificationCount]: async () =>
      notificationCenter.unreadCount(),
    [Commands.MarkNotificationRead]: async (id: string) =>
      notificationCenter.markRead(id),
    [Commands.MarkAllNotificationsRead]: async () =>
      notificationCenter.markAllRead(),
    [Commands.DeleteNotification]: async (id: string) => {
      const notification = notificationCenter.get(id)
      if (
        notification?.kind === 'media-selection-required' &&
        notification.taskId
      )
        await deps.getPendingMediaSelection?.().cancel(notification.taskId)
      return notificationCenter.delete(id)
    },
    [Commands.ClearNotifications]: async () => {
      const pending = deps.getPendingMediaSelection?.()
      for (const selection of pending?.list() ?? [])
        await pending?.cancel(selection.taskId)
      return notificationCenter.clear()
    },
    [Commands.ClearOrdinaryNotifications]: async () =>
      notificationCenter.clearOrdinary(),
  }
}

export function registerNotificationIpc(deps: NotificationIpcDeps): () => void {
  const handlers = buildNotificationHandlers(deps)
  const channels = Object.keys(handlers)

  for (const [channel, handler] of Object.entries(handlers)) {
    registerTrustedIpcHandler(channel, async (_event, ...args) =>
      deps.trackAsyncWork
        ? deps.trackAsyncWork(async () => handler(...args))
        : handler(...args)
    )
  }

  return () => {
    for (const channel of channels) {
      ipcMain.removeHandler(channel)
    }
  }
}
