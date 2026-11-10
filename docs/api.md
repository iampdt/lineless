# API

Everything lives under `/api`. Bodies are JSON. Errors look like
`{"error": {"code": "counter_changed", "message": "…"}}`.

## Creating

| Request | Body | Answer |
| --- | --- | --- |
| `POST /api/queues` | `{"name", "counters": ["Room 1", …], "serviceMinutes"}` | `201 {"code", "staffKey"}` |
| `POST /api/demo` | none | `201 {"code", "staffKey"}`, a demo queue with simulated customers |

Both are limited per client address per hour (10 queues, 30 demos). Names are trimmed and
stripped of control characters; 1–12 counters; 1–120 minutes.

## Reading

`GET /api/q/:code` returns the public view, the same object screens receive:

```json
{
  "version": 12,
  "code": "K7QM4T",
  "name": "Sunrise Clinic",
  "status": "open",
  "demo": false,
  "counters": [{ "id": "…", "name": "Room 1", "serving": 14, "recalls": 0 }],
  "waiting": [15, 16, 18],
  "pace": { "secondsPerTicket": 180, "free": 0, "nextFreeIn": 95 },
  "serverTime": 1794830400000
}
```

`expectedWait(position, pace)` in `src/shared/estimate.ts` turns `pace` into a wait. There are no
names in this view, ever.

## Commands

`POST /api/q/:code/commands` with:

```json
{ "requestId": "3f0c…", "command": { "type": "call_next", "counterId": "…", "expectServing": null } }
```

`requestId` (8–64 characters of `A–Z a–z 0–9 _ -`) is chosen by the client and reused on retries:
a repeat gets the first answer and changes nothing. The same id with a different command is
refused with 422.

| Command | Who | Effect |
| --- | --- | --- |
| `join {device, name?}` | anyone | A ticket at the back of the line, or this device's existing ticket |
| `leave {ticketId, device}` | the ticket's device | Leave the line, freeing the counter if called |
| `call_next {counterId, expectServing}` | staff | Finish whoever is at the counter, call the next person. Refused with 409 `counter_changed` unless `expectServing` is who the counter is serving |
| `recall {ticketId}` | staff | Call the same person again; screens chime |
| `finish {ticketId}` | staff | Done with this person, call nobody yet |
| `no_show {ticketId}` | staff | Called but didn't come |
| `bring_back {ticketId}` | staff | A missed ticket goes back to the front |
| `set_status {status}` | staff | `open`, `paused` (no new joins) or `closed`. Reopening an empty closed line restarts numbers at 1 |
| `clear_waiting` | staff | Remove everyone waiting; only when paused or closed |
| `set_counters {counters: [{id or null, name}]}` | staff | Rename, add, remove (not while serving) |
| `set_auto_serve {on}` | staff | Demo only: rooms call people on their own |

Staff commands need `Authorization: Bearer <staffKey>`.

Answers: `{"type": "joined", "ticket": {"id", "number"}, "existing"}`,
`{"type": "called", "ticket": {"id", "number"} | null}`, or `{"type": "ok"}`.

| Code | Status | Meaning |
| --- | --- | --- |
| `invalid` | 400 | Bad body, or a command that doesn't make sense now |
| `unauthorized` | 401 | Missing or wrong staff key |
| `not_your_ticket` | 403 | Another device's ticket |
| `not_found`, `ticket_not_found`, `counter_not_found` | 404 | |
| `queue_paused`, `queue_closed`, `queue_full` | 409 | Can't join |
| `counter_changed`, `ticket_changed`, `counter_busy` | 409 | The screen is behind; refresh and retry |
| `request_reused` | 422 | Request id used for a different command |
| `rate_limited` | 429 | Too many joins or creations from this address |

## Live updates

`GET /api/q/:code/ws` upgrades to a WebSocket. The first message is the public state. To see more,
send a hello:

```json
{ "type": "hello", "staffKey": "…" }
{ "type": "hello", "ticket": { "id": "…", "device": "…" } }
```

Messages from the server:

- `{"type": "state", "queue": {…}, "staff"?: {…}, "you"?: {…}}` after every change. `staff` has
  the full lists with names and the session's totals; `you` is the customer's own ticket with
  their position.
- `{"type": "denied", "reason": "bad_key" | "unknown_ticket"}`
- `{"type": "gone"}` when the queue has been deleted.

Send `{"type":"ping"}` to keep the connection alive; the runtime answers `{"type":"pong"}`
without waking the queue.
