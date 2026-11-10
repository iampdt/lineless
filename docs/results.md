# Results

What I measured, how, and what it showed. All numbers are from 10 November 2026.

## 1. Live updates under load

`npm run loadtest` opens N WebSockets to a new queue, presses "Call next" M times, and measures
for every press the time from sending the command to each socket receiving the new state. One
machine runs every client, so no clock sync is involved.

| Where | Screens | Presses | Delivered | Command round trip p50 / p95 | Press → screen p50 / p95 / p99 | Press → last screen p50 / max |
| --- | ---: | ---: | ---: | --- | --- | --- |
| Local (workerd, same machine) | 1,000 | 20 | 20,000 of 20,000 | 55 / 86 ms | 44 / 74 / 80 ms | 63 / 83 ms |
| Production, from Bangalore | 1,000 | 20 | 20,000 of 20,000 | 187 / 238 ms | 160 / 212 / 231 ms | 249 / 432 ms |

Production numbers include the network: from Bangalore to Cloudflare's Chennai edge
(`colo=MAA`), then on to wherever the queue's object lives. A health check that never leaves the
edge takes about 50 ms, so most of the rest is the trip to the object and back. The message per
update was 295 bytes.

What this says: one queue's object fans a change out to a thousand screens with no losses, and
a phone sees "It's your turn" about a fifth of a second after the press. What it doesn't say:
how it behaves at 10,000 screens on one queue (not a realistic waiting room) or under many busy
queues at once (each queue is a separate object, so they don't share a bottleneck).

## 2. The wait estimate

`npm run simulate` replays simulated days through the real domain code, the same `apply` the
Durable Object runs, and compares the wait each person was shown when they joined with the wait
they actually had. Three estimators see identical days (same seed, same arrivals and service
times):

- **guess**: the host's "minutes per person", never updated.
- **learned**: learns from every finished service.
- **filtered**: learns, but drops services during which the line ran empty. This is the one in
  production.

The days are deliberately unkind:
- the host's guess is wrong in two of the three scenarios;
- there's a morning rush and a midday lull, and service times vary a lot (lognormal, CV 0.35–0.6);
- 2–8% of people don't show up, and 2–5% leave;
- when nobody is waiting, staff often don't press anything until the next person arrives.

200 days per scenario. "In the range" means the real wait fell inside what the person was shown
(0.5× to 1.5× the middle, ±1 minute).

**Clinic, 2 rooms, guess too high (10 min, real 6)**

| Estimator | People | Median error | 90th pct error | Bias (shown − real) | In the range |
| --- | ---: | ---: | ---: | ---: | ---: |
| guess | 19,399 | 6.5 min | 21.9 min | +9.0 min | 73% |
| learned | 19,399 | 2.5 min | 10.1 min | +1.8 min | 85% |
| filtered | 19,399 | **2.2 min** | **9.7 min** | **+1.1 min** | 85% |

**Service desk, 3 counters, guess too low (3 min, real 7)**

| Estimator | People | Median error | 90th pct error | Bias (shown − real) | In the range |
| --- | ---: | ---: | ---: | ---: | ---: |
| guess | 30,854 | 4.0 min | 16.0 min | −6.3 min | 38% |
| learned | 30,854 | 1.8 min | 7.4 min | +1.2 min | **90%** |
| filtered | 30,854 | **1.7 min** | **7.0 min** | **+0.1 min** | 87% |

**Interview day, 4 panels, guess right (20 min)**

| Estimator | People | Median error | 90th pct error | Bias (shown − real) | In the range |
| --- | ---: | ---: | ---: | ---: | ---: |
| guess | 14,800 | **3.9 min** | **13.2 min** | +3.0 min | **90%** |
| learned | 14,800 | 4.4 min | 16.0 min | +3.7 min | 88% |
| filtered | 14,800 | 4.1 min | 15.3 min | +3.0 min | 89% |

What I take from it:

- **Learning is worth it whenever the guess is wrong**, which is the normal case: the median error
  falls by half or more, and a guess that's too low leaves people waiting twice as long as they
  were told.
- **When the guess is right, learning costs a little.** It adds noise from varied service
  times. I accept that trade: nobody knows their average to the minute.
- **Dropping samples taken while the line ran empty cuts the bias**, from +1.8 to +1.1 minutes and
  from +1.2 to +0.1. Those samples count idle time as service time.
- **The estimate still runs long when people leave or don't show.** That's the interview day's
  +3 minutes. It doesn't model the people ahead who won't be served; it errs toward telling people
  to come back early.

### The version before this one

The first estimator multiplied position by "service time ÷ working counters". Measured with the
range I started with (0.7× to 1.4×) over 100 days per scenario, it put 54%, 68% and 62% of people
inside their range, with a bias of +2.7, +1.2 and +4.5 minutes. The current estimate, with the
same range and days, scored 74%, 80% and 77%, with a bias of +1.2, +0.2 and +3.1 minutes. The first
version ignored two things:
- **Free counters.** Someone joining when a room is free is called in seconds, not after a full
  service.
- **Services already under way.** A room nine minutes into a ten-minute visit frees up soon.

The current estimate projects both (`pace` in `src/domain/estimate.ts`). The range multipliers
then came from the measured spread of real ÷ shown (10th–90th percentile about 0.46–1.47), not
from a guess of my own.

## 3. Breaking it on purpose

| Experiment | What happened |
| --- | --- |
| Three counters press "Call next" in parallel loops until 30 people are called | Each of the 30 was called exactly once, none skipped, numbers in order (test) |
| Two clicks on the same counter at the same moment | One succeeded; the other got 409 `counter_changed` (test) |
| The same "Call next" request sent twice, as a retry after a lost answer | The second got the first's answer; the next person stayed in line (test) |
| The queue's object evicted from memory mid-session | Reloaded from SQLite with the same version and state; the next command carried on (test) |
| A queue with no activity for 31 days | Its alarm deleted it; the code now answers 404 (test) |
| Server restarted while a staff screen and a phone were open | Both showed "Reconnecting…" with the last state; a "Call next" pressed during the outage retried, then said it was offline, and didn't apply; both screens were live within about 5 s of the server coming back, at the same version |
| Someone else's device id used to watch a ticket | Refused (`unknown_ticket`); the customer socket never receives anyone's name (test) |

## 4. Tests

40 tests (`npm test`), run inside the Workers runtime with real Durable Objects and SQLite:
domain rules and the estimator as plain functions, and the API end to end through the Worker,
WebSockets, eviction and alarms.
