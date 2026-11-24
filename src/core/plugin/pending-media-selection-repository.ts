import {
  type PendingMediaSelectionRecord,
  PendingMediaSelectionRecordSchema,
} from '@shared/schemas/pending-media-selection'
import type Database from 'better-sqlite3'

/** The queue shares the task database transaction boundary without a migration. */
export class PendingMediaSelectionRepository {
  constructor(private readonly db: Database.Database) {
    db.exec(`CREATE TABLE IF NOT EXISTS pending_media_selections (
      request_id TEXT PRIMARY KEY, dedup_key TEXT UNIQUE, payload TEXT NOT NULL
    )`)
  }
  get(requestId: string): PendingMediaSelectionRecord | undefined {
    const row = this.db
      .prepare(
        'SELECT payload FROM pending_media_selections WHERE request_id = ?'
      )
      .get(requestId) as { payload: string } | undefined
    return row
      ? PendingMediaSelectionRecordSchema.parse(JSON.parse(row.payload))
      : undefined
  }
  findByDedupKey(key: string): PendingMediaSelectionRecord | undefined {
    const row = this.db
      .prepare(
        'SELECT payload FROM pending_media_selections WHERE dedup_key = ?'
      )
      .get(key) as { payload: string } | undefined
    return row
      ? PendingMediaSelectionRecordSchema.parse(JSON.parse(row.payload))
      : undefined
  }
  list(): PendingMediaSelectionRecord[] {
    return (
      this.db
        .prepare('SELECT payload FROM pending_media_selections ORDER BY rowid')
        .all() as { payload: string }[]
    ).map((row) =>
      PendingMediaSelectionRecordSchema.parse(JSON.parse(row.payload))
    )
  }
  put(record: PendingMediaSelectionRecord): void {
    const parsed = PendingMediaSelectionRecordSchema.parse(record)
    this.db
      .prepare(`INSERT INTO pending_media_selections(request_id, dedup_key, payload)
      VALUES (?, ?, ?) ON CONFLICT(request_id) DO UPDATE SET payload = excluded.payload`)
      .run(parsed.requestId, parsed.dedupKey ?? null, JSON.stringify(parsed))
  }
  remove(requestId: string): void {
    this.db
      .prepare('DELETE FROM pending_media_selections WHERE request_id = ?')
      .run(requestId)
  }
}
