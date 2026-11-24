import '@testing-library/jest-dom/vitest'
import { i18n } from '@renderer/lib/i18n'
import {
  type PlatformServices,
  PlatformServicesProvider,
} from '@renderer/platform/services'
import { Commands } from '@shared/protocol/commands'
import type { MediaSelectionPreview } from '@shared/schemas/plugin-media-selection'
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'
import { AddTaskForm } from './add-task-form'

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('@renderer/lib/transport', () => ({
  transport: { invoke, on: vi.fn(), off: vi.fn() },
}))
vi.mock('@renderer/hooks/use-task-list', () => ({
  invalidateTaskList: vi.fn(),
}))
const preview: MediaSelectionPreview = {
  selectionId: '018f4000-0000-7000-8000-000000000001',
  pluginId: 'video',
  title: 'Video course',
  expiresAt: Date.now() + 60000,
  qualities: ['1080p', '720p', '480p'],
  defaultQuality: '1080p',
  entries: [
    {
      id: 'one',
      title: 'Introduction',
      url: 'https://video.test/one',
      partNumber: 1,
      durationSeconds: 65,
    },
    {
      id: 'two',
      title: 'Next steps',
      url: 'https://video.test/two',
      partNumber: 2,
      durationSeconds: 3661,
    },
  ],
}
const services: PlatformServices = {
  kind: 'web',
  pickSaveDir: vi.fn(),
  closeHost: vi.fn(),
  readClipboard: vi.fn().mockResolvedValue(''),
  openExternal: vi.fn(),
  notify: vi.fn(),
}
beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', {
    configurable: true,
    value() {
      return {
        top: 0,
        left: 0,
        bottom: 600,
        right: 800,
        width: 800,
        height: 600,
      }
    },
  })
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get() {
      return 600
    },
  })
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get() {
      return 600
    },
  })
  Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
    configurable: true,
    get() {
      return 600
    },
  })
  Object.defineProperty(HTMLElement.prototype, 'scrollWidth', {
    configurable: true,
    get() {
      return 800
    },
  })
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
    configurable: true,
    get() {
      return 800
    },
  })
})

function setup(props = {}) {
  return render(
    <PlatformServicesProvider services={services}>
      <AddTaskForm
        subscribeEvents={false}
        defaultValues={{
          tab: 'links',
          urls: 'https://video.test/course',
          saveDir: '/downloads',
          split: 4,
        }}
        onCancel={vi.fn()}
        {...props}
      />
    </PlatformServicesProvider>
  )
}
async function openSelection() {
  await userEvent.click(screen.getByRole('button', { name: 'Download' }))
  return screen.findByRole('dialog', { name: 'Choose videos' })
}
beforeEach(() => {
  invoke.mockImplementation(async (channel) => {
    if (channel === Commands.InspectPluginMedia) return preview
    if (channel === Commands.CreatePluginMediaTasks)
      return { created: [{ entryId: 'two', taskId: 'task-two' }], failed: [] }
    if (channel === Commands.CreateTask)
      return { outcome: 'created', taskId: 'ordinary', gid: 'ordinary' }
    return { app: { autofillClipboardLinks: false } }
  })
})
afterEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
})

describe('Add Task media selection', () => {
  it('downloads a single inspected part at the provider preference without opening the dialog', async () => {
    const singlePreview = { ...preview, entries: [preview.entries[1]!] }
    invoke.mockImplementation(async (channel) => {
      if (channel === Commands.InspectPluginMedia) return singlePreview
      if (channel === Commands.CreatePluginMediaTasks)
        return {
          created: [{ entryId: 'two', taskId: 'single-task' }],
          failed: [],
        }
      return { app: { autofillClipboardLinks: false } }
    })
    const success = vi.fn()
    setup({ onSubmitSuccess: success })
    await userEvent.click(screen.getByRole('button', { name: 'Download' }))
    await waitFor(() => expect(success).toHaveBeenCalledWith('single-task'))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(invoke).toHaveBeenCalledWith(Commands.CreatePluginMediaTasks, {
      selectionId: singlePreview.selectionId,
      entryIds: ['two'],
      quality: '1080p',
      saveDir: '/downloads',
      connections: 4,
    })
  })
  it.each(['720p', '2160p'] as const)(
    'uses the saved %s preference for direct single-part downloads',
    async (quality) => {
      const singlePreview: MediaSelectionPreview = {
        ...preview,
        entries: [preview.entries[0]!],
        qualities: ['2160p', '1440p', '1080p', '720p', '480p'],
        defaultQuality: quality,
        showSinglePartDialog: false,
      }
      invoke.mockImplementation(async (channel) => {
        if (channel === Commands.InspectPluginMedia) return singlePreview
        if (channel === Commands.CreatePluginMediaTasks)
          return {
            created: [{ entryId: 'one', taskId: 'preferred' }],
            failed: [],
          }
        return { app: { mediaSelectionSkipSingleDialog: false } }
      })
      setup()
      await userEvent.click(screen.getByRole('button', { name: 'Download' }))
      await waitFor(() =>
        expect(invoke).toHaveBeenCalledWith(Commands.CreatePluginMediaTasks, {
          selectionId: singlePreview.selectionId,
          entryIds: ['one'],
          quality,
          saveDir: '/downloads',
          connections: 4,
        })
      )
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    }
  )

  it('opens the single-part picker when enabled in plugin settings and keeps its preferred quality', async () => {
    invoke.mockImplementation(async (channel) => {
      if (channel === Commands.InspectPluginMedia)
        return {
          ...preview,
          entries: [preview.entries[0]!],
          defaultQuality: '720p',
          showSinglePartDialog: true,
        }
      return { app: { mediaSelectionSkipSingleDialog: true } }
    })
    setup()
    const dialog = await openSelection()
    expect(
      within(dialog).getByRole('combobox', { name: 'Quality' })
    ).toHaveTextContent('720p')
    expect(
      invoke.mock.calls.some(
        ([channel]) => channel === Commands.CreatePluginMediaTasks
      )
    ).toBe(false)
  })

  it.each(['1080p', '720p', '2160p'] as const)(
    'initially selects and submits the provider %s preference in the multipart picker',
    async (quality) => {
      const preferredPreview: MediaSelectionPreview = {
        ...preview,
        qualities: ['2160p', '1440p', '1080p', '720p', '480p'],
        defaultQuality: quality,
      }
      invoke.mockImplementation(async (channel) => {
        if (channel === Commands.InspectPluginMedia) return preferredPreview
        if (channel === Commands.CreatePluginMediaTasks)
          return {
            created: [{ entryId: 'one', taskId: 'preferred' }],
            failed: [],
          }
        return { app: {} }
      })
      setup()
      const dialog = await openSelection()
      expect(
        within(dialog).getByRole('combobox', { name: 'Quality' })
      ).toHaveTextContent(quality)
      await userEvent.click(
        within(dialog).getByRole('button', { name: 'Download selected' })
      )
      await waitFor(() =>
        expect(invoke).toHaveBeenCalledWith(Commands.CreatePluginMediaTasks, {
          selectionId: preferredPreview.selectionId,
          entryIds: ['one'],
          quality,
          saveDir: '/downloads',
          connections: 4,
        })
      )
    }
  )

  it('keeps the selected highest quality translated in the Chinese trigger', async () => {
    await i18n.changeLanguage('zh-CN')
    try {
      setup()
      await userEvent.click(screen.getByRole('button', { name: '下载' }))
      const dialog = await screen.findByRole('dialog', {
        name: i18n.t('mediaSelection.title'),
      })
      const trigger = within(dialog).getByRole('combobox', {
        name: i18n.t('mediaSelection.quality'),
      })
      await userEvent.click(trigger)
      await userEvent.click(await screen.findByRole('option', { name: '最高' }))
      expect(trigger).toHaveTextContent('最高')
      expect(trigger).not.toHaveTextContent('highest')
      expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    } finally {
      await act(async () => {
        await i18n.changeLanguage('en-US')
      })
    }
  })

  it('always opens the multipart picker using the plugin preference even when the single-part picker is disabled', async () => {
    invoke.mockImplementation(async (channel) => {
      if (channel === Commands.InspectPluginMedia)
        return {
          ...preview,
          defaultQuality: '720p',
          showSinglePartDialog: false,
        }
      return { app: {} }
    })
    setup()
    const dialog = await openSelection()
    expect(
      within(dialog).getByRole('combobox', { name: 'Quality' })
    ).toHaveTextContent('720p')
    expect(within(dialog).getByRole('status')).toHaveTextContent(
      '2 of 2 selected'
    )
  })

  it.each(['web', 'electron'] as const)(
    'submits selected parts and quality through the shared %s form',
    async (kind) => {
      const success = vi.fn()
      render(
        <PlatformServicesProvider services={{ ...services, kind }}>
          <AddTaskForm
            subscribeEvents={false}
            defaultValues={{
              tab: 'links',
              urls: 'https://video.test/course',
              saveDir: '/downloads',
              split: 4,
            }}
            onCancel={vi.fn()}
            onSubmitSuccess={success}
          />
        </PlatformServicesProvider>
      )
      const dialog = await openSelection()
      expect(invoke).toHaveBeenCalledWith(Commands.InspectPluginMedia, {
        url: 'https://video.test/course',
      })
      expect(
        within(dialog).getByRole('checkbox', { name: /Introduction/ })
      ).toBeVisible()
      expect(within(dialog).getByText('1:01:01')).toBeVisible()
      await userEvent.click(
        within(dialog).getByRole('checkbox', { name: 'Select all' })
      )
      expect(
        within(dialog).getByRole('button', { name: 'Download selected' })
      ).toBeDisabled()
      await userEvent.click(
        within(dialog).getByRole('checkbox', { name: 'Select all' })
      )
      await userEvent.click(
        within(dialog).getByRole('checkbox', { name: /Introduction/ })
      )
      expect(within(dialog).getByRole('status')).toHaveTextContent(
        '1 of 2 selected'
      )
      await userEvent.click(
        within(dialog).getByRole('combobox', { name: 'Quality' })
      )
      await userEvent.click(await screen.findByRole('option', { name: '720p' }))
      await userEvent.click(
        within(dialog).getByRole('button', { name: 'Download selected' })
      )
      await waitFor(() => expect(success).toHaveBeenCalledWith('task-two'))
      expect(invoke).toHaveBeenCalledWith(Commands.CreatePluginMediaTasks, {
        selectionId: '018f4000-0000-7000-8000-000000000001',
        entryIds: ['two'],
        quality: '720p',
        saveDir: '/downloads',
        connections: 4,
      })
      expect(
        invoke.mock.calls.some(([channel]) => channel === Commands.CreateTask)
      ).toBe(false)
    }
  )

  it('cancels without creating a task and preserves the original draft', async () => {
    setup()
    const dialog = await openSelection()
    await userEvent.click(
      within(dialog).getByRole('button', { name: 'Cancel' })
    )
    await waitFor(() =>
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    )
    expect(screen.getByRole('textbox', { name: 'URLs' })).toHaveValue(
      'https://video.test/course'
    )
    expect(
      invoke.mock.calls.some(
        ([channel]) =>
          channel === Commands.CreatePluginMediaTasks ||
          channel === Commands.CreateTask
      )
    ).toBe(false)
  })

  it('uses the ordinary submission flow for an unsupported URL', async () => {
    invoke.mockImplementation(async (channel) =>
      channel === Commands.InspectPluginMedia
        ? null
        : channel === Commands.CreateTask
          ? { outcome: 'created', taskId: 'ordinary', gid: 'ordinary' }
          : {}
    )
    const success = vi.fn()
    setup({ onSubmitSuccess: success })
    await userEvent.click(screen.getByRole('button', { name: 'Download' }))
    await waitFor(() => expect(success).toHaveBeenCalledWith('ordinary'))
    expect(invoke).toHaveBeenCalledWith(
      Commands.CreateTask,
      expect.objectContaining({
        uris: ['https://video.test/course'],
        saveDir: '/downloads',
      })
    )
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('retains failed entries and retries without resubmitting created entries', async () => {
    let attempts = 0
    invoke.mockImplementation(async (channel, args) => {
      if (channel === Commands.InspectPluginMedia) return preview
      if (channel === Commands.CreatePluginMediaTasks) {
        if (args.entryIds[0] === 'one') {
          return {
            created: [{ entryId: 'one', taskId: 'task-one' }],
            failed: [],
          }
        }
        attempts += 1
        return attempts === 1
          ? {
              created: [],
              failed: [{ entryId: 'two', message: 'Temporary failure' }],
            }
          : { created: [{ entryId: 'two', taskId: 'task-two' }], failed: [] }
      }
      return {}
    })
    const success = vi.fn()
    setup({ onSubmitSuccess: success })
    await openSelection()
    await userEvent.click(
      screen.getByRole('button', { name: 'Download selected' })
    )
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Next steps: Temporary failure'
    )
    expect(
      screen.queryByRole('checkbox', { name: /Introduction/ })
    ).not.toBeInTheDocument()
    expect(success).not.toHaveBeenCalled()
    await userEvent.click(
      screen.getByRole('button', { name: 'Download selected' })
    )
    await waitFor(() => expect(success).toHaveBeenCalledWith('task-two'))
    expect(
      invoke.mock.calls
        .filter(([channel]) => channel === Commands.CreatePluginMediaTasks)
        .map(([, args]) => args.entryIds)
    ).toEqual([['one'], ['two'], ['two']])
  })

  it('shows inspection failure without falling through to an original URL download', async () => {
    invoke.mockImplementation(async (channel) => {
      if (channel === Commands.InspectPluginMedia)
        throw new Error('Video unavailable')
      return {}
    })
    setup()
    await userEvent.click(screen.getByRole('button', { name: 'Download' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Video unavailable'
    )
    expect(
      invoke.mock.calls.some(([channel]) => channel === Commands.CreateTask)
    ).toBe(false)
  })

  it('ignores inspection responses after the draft changes', async () => {
    let resolve!: (value: MediaSelectionPreview) => void
    invoke.mockImplementation(async (channel) =>
      channel === Commands.InspectPluginMedia
        ? new Promise((done) => {
            resolve = done
          })
        : {}
    )
    setup()
    await userEvent.click(screen.getByRole('button', { name: 'Download' }))
    await waitFor(() => expect(resolve).toBeDefined())
    fireEvent.change(screen.getByRole('textbox', { name: 'URLs' }), {
      target: { value: 'https://other.test/file.zip' },
    })
    await act(async () => resolve(preview))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(
      invoke.mock.calls.some(([channel]) => channel === Commands.CreateTask)
    ).toBe(false)
  })

  it('ignores inspection responses after the form becomes inactive', async () => {
    let resolve!: (value: MediaSelectionPreview) => void
    invoke.mockImplementation(async (channel) =>
      channel === Commands.InspectPluginMedia
        ? new Promise((done) => {
            resolve = done
          })
        : {}
    )
    const view = setup()
    await userEvent.click(screen.getByRole('button', { name: 'Download' }))
    await waitFor(() => expect(resolve).toBeDefined())
    view.rerender(
      <PlatformServicesProvider services={services}>
        <AddTaskForm
          active={false}
          subscribeEvents={false}
          onCancel={vi.fn()}
        />
      </PlatformServicesProvider>
    )
    await act(async () => resolve(preview))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(
      invoke.mock.calls.some(
        ([channel]) =>
          channel === Commands.CreateTask ||
          channel === Commands.CreatePluginMediaTasks
      )
    ).toBe(false)
  })

  it('keeps a failed create visible and allows retrying the same selection', async () => {
    invoke.mockImplementation(async (channel) => {
      if (channel === Commands.InspectPluginMedia) return preview
      if (channel === Commands.CreatePluginMediaTasks)
        throw new Error('Connection interrupted')
      return {}
    })
    setup()
    const dialog = await openSelection()
    await userEvent.click(
      within(dialog).getByRole('button', { name: 'Download selected' })
    )
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Connection interrupted'
    )
    expect(
      within(dialog).getByRole('button', { name: 'Download selected' })
    ).toBeEnabled()
    expect(
      within(dialog)
        .getAllByRole('checkbox')
        .every((box) => box.getAttribute('aria-checked') === 'true')
    ).toBe(true)
    expect(
      invoke.mock.calls.some(([channel]) => channel === Commands.CreateTask)
    ).toBe(false)
  })

  it('preserves the existing batch flow without inspecting multiple URLs', async () => {
    setup({
      defaultValues: {
        tab: 'links',
        urls: 'https://first.test/file\nhttps://second.test/file',
        saveDir: '/downloads',
      },
    })
    await userEvent.click(screen.getByRole('button', { name: 'Download' }))
    await waitFor(() =>
      expect(
        invoke.mock.calls.filter(([channel]) => channel === Commands.CreateTask)
      ).toHaveLength(2)
    )
    expect(
      invoke.mock.calls.some(
        ([channel]) => channel === Commands.InspectPluginMedia
      )
    ).toBe(false)
  })

  it('blocks duplicate clicks and cancellation while selected downloads are being created', async () => {
    let resolve: ((value: unknown) => void) | undefined
    invoke.mockImplementation(async (channel) =>
      channel === Commands.InspectPluginMedia
        ? preview
        : channel === Commands.CreatePluginMediaTasks
          ? resolve
            ? {
                created: [],
                failed: [{ entryId: 'two', message: 'Try again' }],
              }
            : new Promise((done) => {
                resolve = done
              })
          : {}
    )
    setup()
    const dialog = await openSelection()
    const submit = within(dialog).getByRole('button', {
      name: 'Download selected',
    })
    fireEvent.click(submit)
    fireEvent.click(submit)
    await waitFor(() => expect(resolve).toBeDefined())
    expect(
      within(dialog).getByRole('button', { name: 'Cancel' })
    ).toBeDisabled()
    expect(submit).toBeDisabled()
    expect(
      invoke.mock.calls.filter(
        ([channel]) => channel === Commands.CreatePluginMediaTasks
      )
    ).toHaveLength(1)
    await act(async () =>
      resolve!({
        created: [],
        failed: [
          { entryId: 'one', message: 'Try again' },
          { entryId: 'two', message: 'Try again' },
        ],
      })
    )
    expect(await screen.findByRole('alert')).toHaveTextContent('Try again')
  })
})
