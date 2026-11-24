import '@renderer/lib/i18n'
import type { MediaSelectionDialog } from '@renderer/components/add-task/media-selection-dialog'
import { useAddTaskDialogStore } from '@renderer/components/add-task-dialog/use-add-task-dialog-store'
import { transport } from '@renderer/lib/transport'
import type {
  EventListener,
  TransportConnectionListener,
} from '@renderer/lib/transport/types'
import { Commands } from '@shared/protocol/commands'
import { Events } from '@shared/protocol/events'
import { Queries } from '@shared/protocol/queries'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MediaSelectionPendingHost } from './media-selection-pending-host'
import {
  requestPendingMediaSelection,
  usePendingMediaSelectionStore,
} from './store'

const mocks = vi.hoisted(() => ({
  events: new Map<string, EventListener>(),
  connection: null as TransportConnectionListener | null,
  pending: [] as string[],
  entries: ['one', 'two'],
}))
vi.mock('@renderer/lib/transport', () => ({
  transport: {
    invoke: vi.fn(),
    on: vi.fn((channel: string, listener: EventListener) =>
      mocks.events.set(channel, listener)
    ),
    off: vi.fn((channel: string) => mocks.events.delete(channel)),
    onConnectionChange: vi.fn((listener: TransportConnectionListener) => {
      mocks.connection = listener
      return () => {
        mocks.connection = null
      }
    }),
  },
}))
vi.mock('@renderer/hooks/use-task-list', () => ({
  invalidateTaskList: vi.fn(),
  getTaskListSnapshot: () => ({ tasks: [] }),
}))
vi.mock('@renderer/components/add-task/media-selection-dialog', () => ({
  MediaSelectionDialog: ({
    preview,
    busy,
    error,
    onCancel,
    onSubmit,
  }: ComponentProps<typeof MediaSelectionDialog>) => (
    <div role="dialog">
      <span>{preview.title}</span>
      <span>
        {preview.entries.map((entry: { id: string }) => entry.id).join(',')}
      </span>
      {error && <span role="alert">{error}</span>}
      <button type="button" disabled={busy} onClick={onCancel}>
        Dismiss
      </button>
      <button
        type="button"
        disabled={busy}
        onClick={() =>
          onSubmit(
            preview.entries.map((entry: { id: string }) => entry.id),
            'highest'
          )
        }
      >
        Confirm
      </button>
    </div>
  ),
}))

function preview(id: string) {
  return {
    selectionId: '00000000-0000-4000-8000-000000000001',
    pluginId: 'media',
    expiresAt: Date.now() + 60000,
    title: `Selection ${['offline', 'online', 'waiting', 'partial', 'remote', 'reconnected', 'delayed'][Number(id.slice(-12)) - 1]}`,
    entries: mocks.entries.map((entry) => ({
      id: entry,
      title: entry,
      url: `https://example.com/${entry}`,
    })),
    qualities: ['highest'],
    defaultQuality: 'highest',
  }
}
function changed() {
  mocks.events.get(Events.PendingMediaSelectionsChanged)?.()
}
beforeEach(() => {
  vi.clearAllMocks()
  mocks.events.clear()
  mocks.pending = []
  mocks.entries = ['one', 'two']
  useAddTaskDialogStore.setState({ open: false, revision: 0 })
  usePendingMediaSelectionStore.setState({ requestId: null, revision: 0 })
  vi.mocked(transport.invoke).mockImplementation(async (channel, argument) => {
    if (channel === Queries.ListPendingMediaSelections)
      return mocks.pending.map((requestId) => ({
        requestId,
        taskId: requestId,
        url: 'https://example.com/video',
        title: requestId,
        saveDir: '/downloads',
        createdAt: 1,
        expiresAt: Date.now() + 60000,
      }))
    if (channel === Queries.GetPendingMediaSelection) {
      const { requestId } = argument as { requestId: string }
      return mocks.pending.includes(requestId) ? preview(requestId) : null
    }
    if (channel === Commands.ConfirmPendingMediaSelection) {
      mocks.pending = []
      return { created: [{ entryId: 'one', taskId: 'download' }], failed: [] }
    }
    throw new Error(`Unexpected channel ${channel}`)
  })
})

describe('pending media global host', () => {
  it('subscribes before the mount snapshot and opens an offline-enqueued selection', async () => {
    mocks.pending = ['00000000-0000-4000-8000-000000000001']
    render(<MediaSelectionPendingHost />)
    await screen.findByText('Selection offline')
    expect(vi.mocked(transport.on).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(transport.invoke).mock.invocationCallOrder[0]
    )
  })

  it('opens an online enqueue and dismisses only for this page session', async () => {
    render(<MediaSelectionPendingHost />)
    await act(async () => {})
    mocks.pending = ['00000000-0000-4000-8000-000000000002']
    act(changed)
    await screen.findByText('Selection online')
    fireEvent.click(screen.getByText('Dismiss'))
    act(changed)
    await act(async () => {})
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(mocks.pending).toEqual(['00000000-0000-4000-8000-000000000002'])
    expect(transport.invoke).not.toHaveBeenCalledWith(
      Commands.CancelPendingMediaSelection,
      expect.anything()
    )
    act(() =>
      requestPendingMediaSelection('00000000-0000-4000-8000-000000000002')
    )
    await screen.findByText('Selection online')
  })

  it('waits for AddTaskForm and other active dialogs before opening', async () => {
    useAddTaskDialogStore.setState({ open: true })
    mocks.pending = ['00000000-0000-4000-8000-000000000003']
    render(<MediaSelectionPendingHost />)
    await act(async () => {})
    expect(screen.queryByRole('dialog')).toBeNull()
    const other = document.createElement('div')
    other.setAttribute('role', 'dialog')
    document.body.append(other)
    act(() => useAddTaskDialogStore.setState({ open: false }))
    await act(async () => {})
    expect(screen.queryByText('Selection waiting')).toBeNull()
    act(() => other.remove())
    await screen.findByText('Selection waiting')
  })

  it('opens an explicitly requested picker while the non-modal inspector remains open', async () => {
    const inspector = document.createElement('div')
    inspector.setAttribute('role', 'dialog')
    inspector.setAttribute('data-inspector-drawer', 'true')
    document.body.append(inspector)
    try {
      render(<MediaSelectionPendingHost />)
      await act(async () => {})
      mocks.pending = ['00000000-0000-4000-8000-000000000003']
      act(() => requestPendingMediaSelection(mocks.pending[0]!))
      act(changed)
      await screen.findByText('Selection waiting')
      expect(inspector.isConnected).toBe(true)
      expect(screen.getAllByRole('dialog')).toHaveLength(2)
    } finally {
      inspector.remove()
    }
  })

  it('retains failed entries after partial confirmation and closes after retry', async () => {
    mocks.pending = ['00000000-0000-4000-8000-000000000004']
    render(<MediaSelectionPendingHost />)
    await screen.findByText('Selection partial')
    vi.mocked(transport.invoke).mockImplementationOnce(async () => ({
      created: [{ entryId: 'one', taskId: 'download-one' }],
      failed: [{ entryId: 'two', message: 'temporary failure' }],
    }))
    fireEvent.click(screen.getByText('Confirm'))
    await screen.findByRole('alert')
    expect(screen.queryByText('one,two')).toBeNull()
    expect(screen.getByText('two')).toBeTruthy()
    fireEvent.click(screen.getByText('Confirm'))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(transport.invoke).toHaveBeenCalledWith(
      Commands.ConfirmPendingMediaSelection,
      {
        requestId: '00000000-0000-4000-8000-000000000004',
        entryIds: ['two'],
        quality: 'highest',
      }
    )
  })

  it('closes a selection settled by another client and refreshes on reconnect', async () => {
    mocks.pending = ['00000000-0000-4000-8000-000000000005']
    render(<MediaSelectionPendingHost />)
    await screen.findByText('Selection remote')
    mocks.pending = []
    act(changed)
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    mocks.pending = ['00000000-0000-4000-8000-000000000006']
    act(() => mocks.connection?.({ state: 'connected' }))
    await screen.findByText('Selection reconnected')
  })

  it('converges after a provider failure emits one changed-error event', async () => {
    mocks.pending = ['00000000-0000-4000-8000-000000000005']
    render(<MediaSelectionPendingHost />)
    await screen.findByText('Selection remote')
    const original = vi.mocked(transport.invoke).getMockImplementation()!
    let failedGets = 0
    vi.mocked(transport.invoke).mockImplementation(async (channel, ...args) => {
      if (channel === Queries.GetPendingMediaSelection) {
        failedGets += 1
        // Core publishes the changed lastError once, then suppresses identical errors.
        if (failedGets === 1) changed()
        throw new Error('Media provider unavailable')
      }
      return original(channel, ...args)
    })
    await act(async () => changed())
    expect(failedGets).toBeGreaterThan(0)
    expect(failedGets).toBeLessThanOrEqual(2)
    const callsAfterFailure = vi.mocked(transport.invoke).mock.calls.length
    await act(async () => {})
    expect(vi.mocked(transport.invoke).mock.calls).toHaveLength(
      callsAfterFailure
    )
    expect(screen.getByText('Selection remote')).toBeTruthy()
    expect(mocks.pending).toEqual(['00000000-0000-4000-8000-000000000005'])
  })

  it('drops a delayed preview rather than covering a newly opened form', async () => {
    mocks.pending = ['00000000-0000-4000-8000-000000000007']
    let resolve!: (value: unknown) => void
    const original = vi.mocked(transport.invoke).getMockImplementation()!
    vi.mocked(transport.invoke).mockImplementation((channel, ...args) =>
      channel === Queries.GetPendingMediaSelection
        ? new Promise((done) => {
            resolve = done
          })
        : original(channel, ...args)
    )
    render(<MediaSelectionPendingHost />)
    await waitFor(() => expect(resolve).toBeDefined())
    act(() => useAddTaskDialogStore.setState({ open: true }))
    await act(async () =>
      resolve(preview('00000000-0000-4000-8000-000000000007'))
    )
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})
