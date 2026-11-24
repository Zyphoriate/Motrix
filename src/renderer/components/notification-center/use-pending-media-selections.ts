import { useTransportMirror } from '@renderer/hooks/use-transport-mirror'
import { Events } from '@shared/protocol/events'
import { Queries } from '@shared/protocol/queries'
import {
  PendingMediaSelectionListSchema,
  type PendingMediaSelectionSummary,
} from '@shared/schemas/pending-media-selection'
import { useState } from 'react'

/** Pending actions come from the queue, independently of notification history. */
export function usePendingMediaSelections() {
  const [items, setItems] = useState<PendingMediaSelectionSummary[]>([])
  const [ready, setReady] = useState(false)
  const { refresh } = useTransportMirror({
    events: [Events.PendingMediaSelectionsChanged],
    load: async (stale, read) => {
      const result = await read(Queries.ListPendingMediaSelections)
      if (stale()) return
      const list = PendingMediaSelectionListSchema.parse(result ?? [])
      setItems(list)
      setReady(true)
    },
  })
  return { items, ready, refresh }
}
