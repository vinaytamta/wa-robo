# Auto-Posting MVP (Hybrid Input)

## What This Adds

- Posting-focused default UI at `/` (legacy full UI still available at `/full-ui`)
- CSV upload import for message rows
- Manual row entry in UI
- Bulk paste import supporting CSV and TSV
- Local queue scheduler with one-time future timestamps
- Global random delay window (`0..N` minutes) before send
- Group target resolution using `group_jid` first, then `group_name`
- Lifecycle statuses and revision history

## CSV / Paste Headers

Supported headers:

- `row_id` (optional)
- `group_jid` (optional if `group_name` provided)
- `group_name` (optional if `group_jid` provided)
- `scheduled_at` (required, local machine time)
- `message_text` (required)
- `enabled` (optional, defaults to true)

At least one of `group_jid` or `group_name` must be present.

## Status Lifecycle

- `uploaded`: row is stored and editable
- `queued`: row is preparing to run
- `scheduled`: waiting for scheduled time
- `sent`: message successfully posted
- `failed`: send failed or validation/runtime error
- `cancelled`: manually cancelled

## Edit + Revision Behavior

- Every edit appends a new immutable revision record.
- Editing a `sent` row creates a new effective state by resetting the row back to `uploaded`.
- Revision history remains queryable via API.

## API Endpoints

### Settings

- `GET /api/posting/settings`
- `PATCH /api/posting/settings`

### Import

- `POST /api/posting/import/csv-preview`
- `POST /api/posting/import/csv`
- `POST /api/posting/import/paste`

### Jobs

- `GET /api/posting/jobs`
- `POST /api/posting/jobs`
- `PATCH /api/posting/jobs/:id`
- `DELETE /api/posting/jobs/:id`
- `GET /api/posting/jobs/:id/revisions`
- `POST /api/posting/jobs/enqueue`
- `POST /api/posting/jobs/pause`
- `POST /api/posting/jobs/resume`
- `POST /api/posting/jobs/cancel`

### Events

- `GET /api/posting/events` (SSE)

## Notes

- Scheduler uses the app machine local timezone for `scheduled_at`.
- State persists in local data directory under `post-queue.json`.
- Existing non-posting frontend/backend features are preserved and not removed.
