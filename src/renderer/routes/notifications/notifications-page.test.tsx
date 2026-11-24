import '@test-utils/dom-animations'
import '@testing-library/jest-dom/vitest'
import '@renderer/lib/i18n'
import { requestPendingMediaSelection } from '@renderer/components/media-selection-pending/store'
import { __resetTaskListStoreForTests } from '@renderer/hooks/use-task-list'
import { i18n } from '@renderer/lib/i18n'
import { transport } from '@renderer/lib/transport'
import { Commands } from '@shared/protocol/commands'
import { Events } from '@shared/protocol/events'
import { Queries } from '@shared/protocol/queries'
import type { AppNotification } from '@shared/types/notification'
import { TaskStatus } from '@shared/types/task'
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, useLocation } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NotificationsPage } from './notifications-page'

vi.mock('@renderer/components/media-selection-pending/store', () => ({
  requestPendingMediaSelection: vi.fn(),
}))

// Mock transport per pending-approvals-section.test.tsx precedent — the page
// talks to the core through Commands/Queries/Events, not window.motrix.
vi.mock('@renderer/lib/transport', () => ({
  transport: { invoke: vi.fn(), on: vi.fn(), off: vi.fn() },
}))

function notification(
  overrides: Partial<AppNotification> = {}
): AppNotification {
  return {
    id: 'n1',
    sourceKey: 'src1',
    kind: 'task-error',
    severity: 'error',
    titleKey: 'notification.taskError.title',
    titleParams: { name: 'file.zip' },
    bodyKey: null,
    bodyParams: null,
    taskId: 't1',
    createdAt: Date.now() - 60_000,
    readAt: null,
    ...overrides,
  }
}

function mockList(
  items: AppNotification[],
  taskIds = items.flatMap((item) => (item.taskId ? [item.taskId] : [])),
  status = TaskStatus.Completed
) {
  const tasks = taskIds.map((id) => ({ id, status }))
  vi.mocked(transport.invoke).mockImplementation(
    async (ch: string, id: unknown) => {
      if (ch === Queries.ListTasks) return tasks
      if (ch === Queries.GetTaskDetail)
        return tasks.find((task) => task.id === id) ?? null
      if (ch === Queries.ListPendingMediaSelections) return []
      if (ch === Queries.ListNotifications) return items
      if (ch === Queries.GetUnreadNotificationCount) {
        return items.filter((it) => it.readAt === null).length
      }
      return undefined
    }
  )
}

let location = ''
function LocationSpy() {
  const loc = useLocation()
  location = `${loc.pathname}${loc.search}`
  return null
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/notifications']}>
      <LocationSpy />
      <NotificationsPage />
    </MemoryRouter>
  )
}

describe('<NotificationsPage>', () => {
  beforeEach(() => {
    __resetTaskListStoreForTests()
    location = ''
  })
  afterEach(async () => {
    __resetTaskListStoreForTests()
    vi.clearAllMocks()
    // Restore the default locale so a later test file sharing this i18n
    // singleton doesn't inherit zh-CN from a language-switch test elsewhere.
    await i18n.changeLanguage('en-US')
  })

  it('restores an already-read pending selection without task navigation', async () => {
    const requestId = 'e41039c7-34c9-49c6-82e1-057e109fe5f7'
    const entry = {
      requestId,
      taskId: requestId,
      title: 'Video',
      createdAt: 1,
      expiresAt: 9999999999999,
      saveDir: '/downloads',
    }
    mockList([
      notification({
        kind: 'media-selection-required',
        taskId: requestId,
        readAt: 1,
        titleKey: 'mediaSelection.pending.notificationTitle',
        titleParams: { title: 'Video' },
      }),
    ])
    const original = vi.mocked(transport.invoke).getMockImplementation()!
    vi.mocked(transport.invoke).mockImplementation(async (channel, ...args) => {
      if (channel === Queries.ListPendingMediaSelections) return [entry]
      if (channel === Queries.GetPendingMediaSelection) return entry
      return original(channel, ...args)
    })
    renderPage()
    fireEvent.click(await screen.findByText('Choose videos: Video'))
    await waitFor(() =>
      expect(requestPendingMediaSelection).toHaveBeenCalledWith(requestId)
    )
    const row = screen.getByRole('listitem')
    expect(within(row).getByText('Action required')).toBeVisible()
    expect(within(row).getByText('Choose videos')).toBeVisible()
    expect(row.querySelector('.rounded-full')).toHaveClass('bg-amber-400')
    expect(
      screen.queryByRole('region', { name: 'Action required' })
    ).not.toBeInTheDocument()
    expect(transport.invoke).not.toHaveBeenCalledWith(
      Queries.GetTaskDetail,
      requestId
    )
    expect(location).toBe('/notifications')
  })

  it('marks a settled selection handled after a fresh queue check and never reopens it', async () => {
    const requestId = 'e41039c7-34c9-49c6-82e1-057e109fe5f7'
    const entry = {
      requestId,
      taskId: requestId,
      title: 'Video',
      createdAt: 1,
      expiresAt: 9999999999999,
      saveDir: '/downloads',
    }
    let list = [entry]
    mockList([
      notification({
        kind: 'media-selection-required',
        taskId: requestId,
        titleKey: 'mediaSelection.pending.notificationTitle',
        titleParams: { title: 'Video' },
      }),
    ])
    const original = vi.mocked(transport.invoke).getMockImplementation()!
    vi.mocked(transport.invoke).mockImplementation(async (channel, ...args) => {
      if (channel === Queries.ListPendingMediaSelections) return list
      if (channel === Queries.GetPendingMediaSelection) {
        list = []
        return null
      }
      return original(channel, ...args)
    })
    renderPage()
    await screen.findByText('Action required')
    fireEvent.click(screen.getByText('Choose videos: Video'))
    expect(await screen.findByText('Already handled')).toBeVisible()
    expect(requestPendingMediaSelection).not.toHaveBeenCalled()
  })

  it('shows only the empty history state when pending selections have no notification', async () => {
    const requestId = 'e41039c7-34c9-49c6-82e1-057e109fe5f7'
    const entry = {
      requestId,
      taskId: requestId,
      title: 'Video',
      createdAt: 1,
      expiresAt: 9999999999999,
      saveDir: '/downloads',
    }
    mockList([])
    const original = vi.mocked(transport.invoke).getMockImplementation()!
    vi.mocked(transport.invoke).mockImplementation(async (channel, ...args) => {
      if (channel === Queries.ListPendingMediaSelections) return [entry]
      if (channel === Queries.GetPendingMediaSelection) return entry
      return original(channel, ...args)
    })
    renderPage()
    expect(await screen.findByText('No notifications')).toBeVisible()
    await waitFor(() =>
      expect(transport.invoke).toHaveBeenCalledWith(
        Queries.ListPendingMediaSelections
      )
    )
    expect(
      screen.queryByRole('region', { name: 'Action required' })
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Choose videos' })
    ).not.toBeInTheDocument()
    expect(requestPendingMediaSelection).not.toHaveBeenCalled()
  })

  it('renders the Empty state when there are no notifications, without a list role', async () => {
    mockList([])
    renderPage()
    expect(await screen.findByText('No notifications')).toBeInTheDocument()
    expect(
      screen.getByText(
        'Download activity and important app notices will show up here'
      )
    ).toBeInTheDocument()
    // The Empty state isn't a list — the row container must not claim
    // role="list" over zero list items.
    expect(screen.queryByRole('list')).not.toBeInTheDocument()
  })

  it('renders the raw key and warns when titleKey is unknown to the catalog', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mockList([
      notification({
        titleKey: 'notification.totallyUnknownKey',
        titleParams: null,
      }),
    ])
    renderPage()
    expect(
      await screen.findByText('notification.totallyUnknownKey')
    ).toBeInTheDocument()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('exposes the row container as a list with a listitem per row', async () => {
    mockList([
      notification({ id: 'n1' }),
      notification({
        id: 'n2',
        titleParams: { name: 'other.zip' },
      }),
    ])
    renderPage()
    await screen.findByText('file.zip failed')

    const list = screen.getByRole('list')
    expect(screen.getAllByRole('listitem')).toHaveLength(2)
    expect(list.children).toHaveLength(2)
  })

  it('labels the row button with the unread suffix for unread rows and the plain title for read rows', async () => {
    mockList([
      notification({ id: 'n1', readAt: null }),
      notification({
        id: 'n2',
        readAt: Date.now(),
        titleParams: { name: 'other.zip' },
      }),
    ])
    renderPage()
    await screen.findByText('file.zip failed')

    expect(
      screen.getByRole('button', { name: 'file.zip failed (unread)' })
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'other.zip failed' })
    ).toBeInTheDocument()
  })

  it('opens an existing failed task and marks read when the row is clicked', async () => {
    mockList(
      [notification({ id: 'n1', taskId: 't1' })],
      ['t1'],
      TaskStatus.Error
    )
    renderPage()
    const row = await screen.findByText('file.zip failed')
    fireEvent.click(row)
    await waitFor(() =>
      expect(transport.invoke).toHaveBeenCalledWith(
        Commands.MarkNotificationRead,
        'n1'
      )
    )
    await waitFor(() => expect(location).toBe('/downloads/all?task=t1'))
    expect(transport.invoke).toHaveBeenCalledWith(Queries.GetTaskDetail, 't1')
  })

  it('opens a completed task from the row without a separate action button', async () => {
    mockList([
      notification({
        kind: 'task-complete',
        severity: 'info',
        titleKey: 'notification.taskComplete.title',
      }),
    ])
    renderPage()
    await screen.findByText('file.zip finished downloading')
    const row = screen.getByRole('listitem')
    expect(row.querySelector('.rounded-full')).toHaveClass('bg-emerald-600')
    expect(
      row.querySelector('[data-icon="status-complete"]')?.parentElement
    ).toHaveClass('text-emerald-600')
    expect(screen.queryByText('View task')).not.toBeInTheDocument()
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'file.zip finished downloading (unread)',
      })
    )
    await waitFor(() => expect(location).toBe('/downloads/all?task=t1'))
    expect(transport.invoke).toHaveBeenCalledWith(Queries.GetTaskDetail, 't1')
    expect(transport.invoke).toHaveBeenCalledWith(
      Commands.MarkNotificationRead,
      'n1'
    )
  })

  it('renders an informational notification with a green info icon', async () => {
    mockList([notification({ severity: 'info', taskId: null })])
    renderPage()
    await screen.findByText('file.zip failed')
    expect(
      screen.getByRole('listitem').querySelector('[data-icon="info"]')
        ?.parentElement
    ).toHaveClass('text-emerald-600', 'dark:text-emerald-400')
  })

  it('does not navigate when the notification has no taskId', async () => {
    mockList([notification({ id: 'n1', taskId: null })])
    renderPage()
    const row = await screen.findByText('file.zip failed')
    fireEvent.click(row)
    await waitFor(() =>
      expect(transport.invoke).toHaveBeenCalledWith(
        Commands.MarkNotificationRead,
        'n1'
      )
    )
    expect(location).toBe('/notifications')
  })

  it('deletes a single row via its delete command', async () => {
    mockList([notification({ id: 'n1' })])
    renderPage()
    await screen.findByText('file.zip failed')
    fireEvent.click(screen.getByRole('button', { name: /remove/i }))
    await waitFor(() =>
      expect(transport.invoke).toHaveBeenCalledWith(
        Commands.DeleteNotification,
        'n1'
      )
    )
    expect(transport.invoke).not.toHaveBeenCalledWith(
      Commands.MarkNotificationRead,
      'n1'
    )
    expect(transport.invoke).not.toHaveBeenCalledWith(
      Queries.GetTaskDetail,
      't1'
    )
    expect(location).toBe('/notifications')
  })

  it('enables clearing ordinary notifications when every notification is already read', async () => {
    mockList([notification({ readAt: Date.now() })])
    renderPage()
    await screen.findByText('file.zip failed')
    expect(
      screen.getByRole('button', { name: /clear ordinary notifications/i })
    ).toBeEnabled()
    expect(screen.getByRole('button', { name: /^clear$/i })).toBeEnabled()
  })

  it('opens an already-read task without another read write', async () => {
    mockList([notification({ readAt: Date.now(), taskId: 'task&other=1' })])
    renderPage()
    fireEvent.click(
      await screen.findByRole('button', { name: 'file.zip failed' })
    )
    await waitFor(() =>
      expect(location).toBe('/downloads/all?task=task%26other%3D1')
    )
    expect(transport.invoke).not.toHaveBeenCalledWith(
      Commands.MarkNotificationRead,
      'n1'
    )
  })

  it('marks a deleted task notification read without querying or navigating', async () => {
    mockList([notification()], [])
    renderPage()
    expect(await screen.findByText('Task removed')).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: /^file.zip failed/ })
    ).toHaveAttribute('title', 'Task removed')
    fireEvent.click(screen.getByText('file.zip failed'))
    await waitFor(() =>
      expect(transport.invoke).toHaveBeenCalledWith(
        Commands.MarkNotificationRead,
        'n1'
      )
    )
    expect(location).toBe('/notifications')
    expect(transport.invoke).not.toHaveBeenCalledWith(
      Queries.GetTaskDetail,
      't1'
    )
    expect(transport.invoke).not.toHaveBeenCalledWith(
      Commands.DeleteNotification,
      'n1'
    )
  })

  it('stops navigating when a task is removed while the page is open', async () => {
    mockList([notification()])
    renderPage()
    await screen.findByRole('button', { name: /^file.zip failed/ })
    const listener = vi
      .mocked(transport.on)
      .mock.calls.find(([channel]) => channel === Events.TaskUpdated)?.[1]
    act(() => listener?.([{ id: 't1', status: TaskStatus.Removed }]))
    expect(await screen.findByText('Task removed')).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: /^file.zip failed/ })
    ).toHaveAttribute('title', 'Task removed')
    fireEvent.click(screen.getByText('file.zip failed'))
    await waitFor(() =>
      expect(transport.invoke).toHaveBeenCalledWith(
        Commands.MarkNotificationRead,
        'n1'
      )
    )
    expect(transport.invoke).not.toHaveBeenCalledWith(
      Queries.GetTaskDetail,
      't1'
    )
    expect(location).toBe('/notifications')
  })

  it.each([null, { id: 't1', status: TaskStatus.Removed }])(
    'does not navigate when the fresh task check returns %s',
    async (task) => {
      mockList([notification({ readAt: Date.now() })])
      renderPage()
      const button = await screen.findByRole('button', {
        name: /^file.zip failed/,
      })
      vi.mocked(transport.invoke).mockResolvedValueOnce(task)
      fireEvent.click(button)
      expect(await screen.findByText('Task removed')).toBeInTheDocument()
      expect(location).toBe('/notifications')
      expect(
        screen.getByRole('button', { name: /^file.zip failed/ })
      ).toBeDisabled()
    }
  )

  it('allows retry after a failed task check without claiming the task was deleted', async () => {
    mockList([notification({ readAt: Date.now() })])
    renderPage()
    const button = await screen.findByRole('button', {
      name: /^file.zip failed/,
    })
    vi.mocked(transport.invoke).mockRejectedValueOnce(new Error('Disconnected'))
    fireEvent.click(button)
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Couldn’t open the task. Try again.'
    )
    expect(location).toBe('/notifications')
    expect(screen.queryByText('Task removed')).not.toBeInTheDocument()
    fireEvent.click(button)
    await waitFor(() => expect(location).toBe('/downloads/all?task=t1'))
  })

  it('does not follow a stale task response after a removal event', async () => {
    mockList([notification({ readAt: Date.now() })])
    renderPage()
    const button = await screen.findByRole('button', {
      name: /^file.zip failed/,
    })
    let resolveTask!: (task: unknown) => void
    vi.mocked(transport.invoke).mockReturnValueOnce(
      new Promise((resolve) => {
        resolveTask = resolve
      })
    )
    fireEvent.click(button)
    fireEvent.click(button)
    const listener = vi
      .mocked(transport.on)
      .mock.calls.find(([channel]) => channel === Events.TaskUpdated)?.[1]
    act(() => listener?.([]))
    await act(async () =>
      resolveTask({ id: 't1', status: TaskStatus.Completed })
    )
    expect(location).toBe('/notifications')
    expect(screen.getByText('Task removed')).toBeInTheDocument()
    expect(
      vi
        .mocked(transport.invoke)
        .mock.calls.filter(([channel]) => channel === Queries.GetTaskDetail)
    ).toHaveLength(1)
  })

  it('checks the task on row click if the task list could not be loaded', async () => {
    mockList([notification({ readAt: Date.now() })])
    const invoke = vi.mocked(transport.invoke).getMockImplementation()!
    vi.mocked(transport.invoke).mockImplementation((channel, ...args) =>
      channel === Queries.ListTasks
        ? Promise.reject(new Error('Disconnected'))
        : invoke(channel, ...args)
    )
    renderPage()
    const button = await screen.findByRole('button', {
      name: /^file.zip failed/,
    })
    expect(screen.queryByText('Task removed')).not.toBeInTheDocument()
    fireEvent.click(button)
    await waitFor(() => expect(location).toBe('/downloads/all?task=t1'))
  })

  it('does not navigate after leaving the notification page during a task check', async () => {
    mockList([notification({ readAt: Date.now() })])
    const view = renderPage()
    const button = await screen.findByRole('button', {
      name: /^file.zip failed/,
    })
    let resolveTask!: (task: unknown) => void
    vi.mocked(transport.invoke).mockReturnValueOnce(
      new Promise((resolve) => {
        resolveTask = resolve
      })
    )
    fireEvent.click(button)
    view.rerender(
      <MemoryRouter initialEntries={['/notifications']}>
        <LocationSpy />
      </MemoryRouter>
    )
    await act(async () =>
      resolveTask({ id: 't1', status: TaskStatus.Completed })
    )
    expect(location).toBe('/notifications')
  })

  it('keeps a failed deletion visible and allows retrying it', async () => {
    mockList([notification()])
    renderPage()
    await screen.findByText('file.zip failed')
    vi.mocked(transport.invoke).mockRejectedValueOnce(new Error('Disconnected'))
    fireEvent.click(
      screen.getByRole('button', { name: 'Remove file.zip failed' })
    )
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Couldn’t update notifications. Try again.'
    )
    expect(screen.getByText('file.zip failed')).toBeInTheDocument()
    fireEvent.click(
      screen.getByRole('button', { name: 'Remove file.zip failed' })
    )
    await waitFor(() =>
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    )
    expect(
      vi
        .mocked(transport.invoke)
        .mock.calls.filter(
          ([channel]) => channel === Commands.DeleteNotification
        )
    ).toHaveLength(2)
  })

  it('double-check deletes ordinary notifications, including read items, and preserves selections', async () => {
    const ordinary = notification({ id: 'n1', readAt: 1 })
    const selection = notification({
      id: 'n2',
      kind: 'media-selection-required',
    })
    let items = [ordinary, selection]
    mockList(items)
    const original = vi.mocked(transport.invoke).getMockImplementation()!
    vi.mocked(transport.invoke).mockImplementation(async (channel, ...args) => {
      if (channel === Commands.ClearOrdinaryNotifications) {
        items = [selection]
        return
      }
      if (channel === Queries.ListNotifications) return items
      return original(channel, ...args)
    })
    renderPage()
    await screen.findAllByText('file.zip failed')
    await userEvent.click(
      screen.getByRole('button', { name: /clear ordinary notifications/i })
    )
    await waitFor(() => expect(screen.getAllByRole('listitem')).toHaveLength(1))
    expect(transport.invoke).toHaveBeenCalledWith(
      Commands.ClearOrdinaryNotifications
    )
    expect(transport.invoke).not.toHaveBeenCalledWith(
      Commands.MarkNotificationRead,
      expect.anything()
    )
    expect(transport.invoke).not.toHaveBeenCalledWith(
      Commands.CancelPendingMediaSelection,
      expect.anything()
    )
  })

  it('allows clearing older ordinary notifications hidden behind a page of pending choices', async () => {
    mockList(
      Array.from({ length: 100 }, (_, index) =>
        notification({
          id: `pending-${index}`,
          kind: 'media-selection-required',
        })
      )
    )
    renderPage()
    await screen.findAllByText('file.zip failed')
    fireEvent.click(
      screen.getByRole('button', { name: /clear ordinary notifications/i })
    )
    await waitFor(() =>
      expect(transport.invoke).toHaveBeenCalledWith(
        Commands.ClearOrdinaryNotifications
      )
    )
  })

  it('clears history through one backend command and refreshes the pending queue', async () => {
    const requestId = 'e41039c7-34c9-49c6-82e1-057e109fe5f7'
    let pending = [
      {
        requestId,
        taskId: requestId,
        title: 'Video',
        createdAt: 1,
        expiresAt: 9999999999999,
        saveDir: '/downloads',
      },
    ]
    let items = [
      notification(),
      notification({
        id: 'media',
        kind: 'media-selection-required',
        taskId: requestId,
      }),
    ]
    mockList(items)
    const original = vi.mocked(transport.invoke).getMockImplementation()!
    vi.mocked(transport.invoke).mockImplementation(async (channel, ...args) => {
      if (channel === Commands.ClearNotifications) {
        items = []
        pending = []
        return
      }
      if (channel === Queries.ListNotifications) return items
      if (channel === Queries.ListPendingMediaSelections) return pending
      return original(channel, ...args)
    })
    renderPage()
    await screen.findByText('Action required')
    const pendingReads = vi
      .mocked(transport.invoke)
      .mock.calls.filter(
        ([channel]) => channel === Queries.ListPendingMediaSelections
      ).length
    await userEvent.click(screen.getByRole('button', { name: 'Clear' }))
    expect(await screen.findByText('No notifications')).toBeVisible()
    expect(transport.invoke).toHaveBeenCalledWith(Commands.ClearNotifications)
    expect(transport.invoke).not.toHaveBeenCalledWith(
      Commands.CancelPendingMediaSelection,
      expect.anything()
    )
    expect(
      vi
        .mocked(transport.invoke)
        .mock.calls.filter(
          ([channel]) => channel === Queries.ListPendingMediaSelections
        ).length
    ).toBeGreaterThan(pendingReads)
  })

  it('refreshes pending selections after deleting a selection notification', async () => {
    const requestId = 'e41039c7-34c9-49c6-82e1-057e109fe5f7'
    let pending = [
      {
        requestId,
        taskId: requestId,
        title: 'Video',
        createdAt: 1,
        expiresAt: 9999999999999,
        saveDir: '/downloads',
      },
    ]
    let items = [
      notification({ kind: 'media-selection-required', taskId: requestId }),
    ]
    mockList(items)
    const original = vi.mocked(transport.invoke).getMockImplementation()!
    vi.mocked(transport.invoke).mockImplementation(async (channel, ...args) => {
      if (channel === Commands.DeleteNotification) {
        items = []
        pending = []
        return
      }
      if (channel === Queries.ListNotifications) return items
      if (channel === Queries.ListPendingMediaSelections) return pending
      return original(channel, ...args)
    })
    renderPage()
    await screen.findByText('Action required')
    const pendingReads = vi
      .mocked(transport.invoke)
      .mock.calls.filter(
        ([channel]) => channel === Queries.ListPendingMediaSelections
      ).length
    await userEvent.click(
      screen.getByRole('button', { name: 'Remove file.zip failed' })
    )
    expect(await screen.findByText('No notifications')).toBeVisible()
    expect(transport.invoke).toHaveBeenCalledWith(
      Commands.DeleteNotification,
      'n1'
    )
    expect(
      vi
        .mocked(transport.invoke)
        .mock.calls.filter(
          ([channel]) => channel === Queries.ListPendingMediaSelections
        ).length
    ).toBeGreaterThan(pendingReads)
    expect(transport.invoke).not.toHaveBeenCalledWith(
      Commands.CancelPendingMediaSelection,
      expect.anything()
    )
  })

  it('refetches the list when a NotificationsChanged event fires', async () => {
    mockList([notification({ id: 'n1' })])
    renderPage()
    await screen.findByText('file.zip failed')

    mockList([notification({ id: 'n2', titleParams: { name: 'other.zip' } })])
    const changedListener = vi
      .mocked(transport.on)
      .mock.calls.find((c) => c[0] === Events.NotificationsChanged)?.[1] as
      | (() => void)
      | undefined
    expect(changedListener).toBeTruthy()
    changedListener?.()

    expect(await screen.findByText('other.zip failed')).toBeInTheDocument()
    expect(screen.queryByText('file.zip failed')).not.toBeInTheDocument()
  })

  it('re-renders with translated copy when the language switches to zh-CN', async () => {
    mockList([notification({ id: 'n1', titleParams: { name: 'file.zip' } })])
    renderPage()
    await screen.findByText('file.zip failed')

    await act(async () => {
      await i18n.changeLanguage('zh-CN')
    })

    expect(await screen.findByText('file.zip 下载失败')).toBeInTheDocument()
    expect(screen.queryByText('file.zip failed')).not.toBeInTheDocument()
  })
})
