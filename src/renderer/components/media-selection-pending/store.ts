import { create } from 'zustand'

interface PendingMediaSelectionState {
  requestId: string | null
  revision: number
  requestSelection: (requestId: string) => void
  clear: (revision: number) => void
}

export const usePendingMediaSelectionStore = create<PendingMediaSelectionState>(
  (set) => ({
    requestId: null,
    revision: 0,
    requestSelection: (requestId) =>
      set((state) => ({ requestId, revision: state.revision + 1 })),
    clear: (revision) =>
      set((state) => (state.revision === revision ? { requestId: null } : {})),
  })
)

export function requestPendingMediaSelection(requestId: string) {
  usePendingMediaSelectionStore.getState().requestSelection(requestId)
}
