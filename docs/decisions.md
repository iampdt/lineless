# Design decisions

Each entry: what I decided, why, and what it costs.

## D1. One Durable Object per queue

**Decision.** Every queue is a Cloudflare Durable Object with its own SQLite database. All
commands for a queue run inside that object.

**Why.** The core correctness problem is concurrency on one queue: two staff press "Call next"
at the same moment, a customer joins while someone is being called. A Durable Object runs one
event at a time and only switches at an `await`. `commit` reads the state, applies the command and
persists it with no `await` in between (hashing happens before), so commands are serialised by
construction. I don't need locks, transactions across services or retry loops on conflicts.

**Cost.** One queue's throughput is bounded by one object (thousands of small commands a second,
far above what a line of people produces). An object lives in one place, near where it was
first created, so screens far away pay the network distance. Queues are independent, so the
system scales by adding queues, not by making one queue bigger.

## D2. Commands over HTTP, state over a WebSocket

**Decision.** Changes are `POST /api/q/:code/commands` requests; screens receive state over a
WebSocket and never send changes through it.

**Why.** A command needs a clear answer (done, refused, why), retries, status codes and
idempotency. A push channel needs none of that. Keeping them apart keeps both simple, and the
WebSocket can be dropped and reopened at any time without losing a command.

## D3. Send the whole state, not events

**Decision.** Every update is a full snapshot of what that screen may see, with a version
number. Clients keep the newest version.

**Why.** Phones lose connections constantly. With events, a client that misses one is wrong
until something notices, which needs sequence numbers, gap detection and replay. With
snapshots, a reconnect needs nothing: the first message is the truth. A snapshot is small
(about 300 bytes for a short line, a few KB at the 500-person cap), so the bandwidth cost is
small.

**Cost.** Messages grow with the line. At the cap that's a few KB per update per screen, which
is fine for a waiting room and wouldn't be for a stadium.

## D4. Idempotency keys *and* compare-and-set: two different bugs

**Decision.** Every command carries a client-chosen request id; the answer is stored for a day
and returned for a repeat. Separately, "Call next" carries the ticket the screen thinks is at
that counter (`expectServing`) and is refused if the counter has moved on.

**Why.** They fix different failures:

- *A retry.* The request reached the queue, the answer was lost, the client retries. Without the
  stored answer, the retry calls the *next* person and someone is skipped. Same request id →
  same answer, nothing applied twice. A reused id with a different command is refused (422).
- *A double click, or two people at one counter.* Two distinct requests with distinct ids, both
  legitimate as far as idempotency goes. The second finds the counter already serving someone
  else and is refused (409) instead of skipping a person.

Both are tested (`test/api.test.ts`, "calling under concurrency").

## D5. The staff key is the only staff credential

**Decision.** Creating a queue returns a random 256-bit staff key. The staff link carries it in
the URL fragment (`/q/CODE/staff#key=…`), which browsers never send to a server; the page moves
it to local storage and removes it from the address bar. The queue stores only its SHA-256 and
compares digests in constant time.

**Why.** No accounts means anyone can start a line in seconds, which is the point for a clinic or
an interview day. The fragment keeps the key out of server logs and referrers.

**Cost.** A leaked staff link can't be revoked without starting a new queue. Key rotation is the
first thing I'd add.

## D6. A device id is the customer's credential

**Decision.** The browser generates a random id and keeps it. Joining sends it; the queue stores
its hash on the ticket. Leaving, or subscribing to your own ticket's updates, requires it.

**Why.** No sign-up, but nobody can remove someone else from the line or see someone else's
ticket. One active ticket per device also makes a double tap on "Join" harmless.

**Cost.** Clearing site data loses the ticket; the person can still see their number on the
display and talk to the desk.

## D7. Names are optional and staff-only

**Decision.** The public view, which customers and the TV receive, has numbers and never names.
Finished tickets are deleted after 7 days; queues nobody uses for 30 days are deleted.

**Why.** A waiting room shouldn't broadcast who is there. Tested: the customer's socket never
receives another person's name.

## D8. A wait estimate that learns, and says how unsure it is

**Decision.** The estimate starts at the host's "minutes per person" and learns from finished
services (running mean, then an exponentially weighted average). Services during which the line
ran empty are dropped. The wait accounts for free counters and how far along busy ones are, and
is shown as a range of 0.5× to 1.5× the middle.

**Why.** Each part was measured (docs/results.md). Learning beats a fixed guess whenever the guess
is wrong. Dropping "line ran empty" samples matters because staff press "Call next" when the next
person arrives, not when the last one left, so idle time would otherwise count as service time.
Ignoring free counters and elapsed services made every estimate a few minutes too long. The range
was set from the measured spread, not picked.

**Cost.** It assumes first come, first served and one kind of service. A clinic with appointment
slots mixed in, or a desk where some visits take 2 minutes and others 30, needs more than one
estimate.

## D9. Leading-edge broadcast with a 50 ms gap

**Decision.** The first change after a quiet period is broadcast at once; further changes within
50 ms coalesce into one more broadcast.

**Why.** "Call next" should feel instant, but a burst (a demo tick, a crowd joining at once)
shouldn't serialise the state to every screen once per command.

## D10. Abuse limits sized for a real waiting room

**Decision.**
- 10 queues and 30 demos per client address per hour, counted in a small Durable Object per
  address hash.
- 30 joins per address per queue per 10 minutes, counted in the queue's memory.
- 500 waiting people per queue (40 in a demo), and 2,000 connected screens.
- Request bodies over 8 KB are refused.
- Unknown codes never create storage.

**Why.** It's a public demo on the internet. The join limit has to allow a clinic's shared Wi-Fi,
so it's generous. Keeping it in memory means it resets if the object is evicted, which I accept
for a limit whose job is to slow abuse, not account for it.

## D11. A real queue as the demo

**Decision.** The demo is a normal queue with a flag. Its alarm adds simulated customers, and can
call people on its own, only while someone has it open. It expires after a day.

**Why.** A recruiter or a clinic owner should see the actual product, not a recording. The flag
is the only difference, and the simulation stops when nobody is watching, so it costs nothing
when idle.

## D12. Checks gate every deploy

**Decision.** `npm run deploy` runs the type check, every test and the build first, and stops on
any failure.

**Why.** The first deploy chained the steps by hand, a type error didn't stop it, and an older
build went out. Now a deploy can't skip the checks.

## D13. Score every real estimate

**Decision.** When someone joins, their ticket keeps the expected wait they were shown. When
they're called, the queue scores it against the real wait, using the same "inside the range"
test as the simulation (`withinRange` in `src/shared/estimate.ts`). Totals are kept for the
session and for the queue's whole life. A name-free CSV report has the per-ticket data.

**Why.** The simulation says how the estimate should behave; only real lines say how it does.
Recording it from the first real customer means a trial needs no extra setup to produce a
number, and the number uses the same definition as the published one. Simulated demo customers
and people brought back after missing their turn aren't scored.

## D14. Numbers for people without phones

**Decision.** Staff can add someone to the line from the staff screen. Their ticket belongs to
no device, so nobody can act for it, and they follow their number on the TV.

**Why.** A clinic's waiting room includes people without smartphones. A queue that only works
for phone owners would push them back to paper, and staff would run two systems.
