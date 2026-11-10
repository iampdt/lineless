import { type FormEvent, useState } from "react";
import { LIMITS } from "../../shared/protocol";
import { ApiError, createDemo, createQueue } from "../lib/api";
import { saveStaffKey } from "../lib/storage";
import { navigate } from "../router";
import { Footer, Header, Notice, SOURCE_URL } from "../components/ui";

export function Home() {
  const [demoBusy, setDemoBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const startDemo = async () => {
    setDemoBusy(true);
    setError(null);
    try {
      const { code, staffKey } = await createDemo();
      saveStaffKey(code, staffKey);
      navigate(`/q/${code}/staff`);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Couldn't start the demo. Try again.");
      setDemoBusy(false);
    }
  };

  return (
    <div className="min-h-screen">
      <Header>
        <a className="btn-quiet hidden sm:inline-flex" href={`${SOURCE_URL}#how-it-works`}>
          How it works
        </a>
        <a className="btn-secondary" href={SOURCE_URL}>
          GitHub
        </a>
      </Header>

      <main className="mx-auto max-w-6xl px-4 sm:px-6">
        <section className="grid items-center gap-10 py-10 sm:py-16 lg:grid-cols-[1.1fr_0.9fr]">
          <div>
            <p className="pill mb-5 bg-brand-soft text-brand">For clinics, salons, service desks and interview days</p>
            <h1 className="text-4xl font-bold leading-[1.1] tracking-tight sm:text-5xl">
              Wait anywhere.
              <br />
              Get called on your phone.
            </h1>
            <p className="mt-5 max-w-xl text-lg text-muted">
              People scan a QR code, see their place in line and how long it'll be, and get called when it's their
              turn. No app to install, no sign-up, nobody shouting names across a crowded room.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <button type="button" className="btn-primary px-5 py-3 text-base" onClick={startDemo} disabled={demoBusy}>
                {demoBusy ? "Starting…" : "Try the live demo"}
              </button>
              <a className="btn-secondary px-5 py-3 text-base" href="#start">
                Start a line
              </a>
            </div>
            <p className="mt-3 text-sm text-muted">
              The demo opens the staff screen next to a phone. Press “Call next” and watch the phone.
            </p>
            {error && (
              <div className="mt-4 max-w-md">
                <Notice tone="danger">{error}</Notice>
              </div>
            )}
          </div>
          <PhonePreview />
        </section>

        <section className="grid gap-4 py-8 sm:grid-cols-3" aria-label="How it works">
          {[
            ["1", "Scan to join", "A QR code at the door, or a six-letter code. Their phone becomes the ticket."],
            ["2", "Wait anywhere", "Their place and estimated wait update live, learned from how fast the line really moves."],
            ["3", "Get called", "A chime, a vibration and a full-screen “It's your turn — Room 2”."],
          ].map(([n, title, body]) => (
            <div key={n} className="card p-5">
              <div className="mb-3 flex h-8 w-8 items-center justify-center rounded-full bg-brand text-sm font-bold text-white">
                {n}
              </div>
              <h2 className="font-semibold">{title}</h2>
              <p className="mt-1 text-sm text-muted">{body}</p>
            </div>
          ))}
        </section>

        <section id="start" className="grid gap-8 py-12 lg:grid-cols-2">
          <div>
            <h2 className="text-2xl font-bold tracking-tight">Start a line</h2>
            <p className="mt-3 text-muted">
              You get a staff link to run the line from any phone or laptop, a QR code to print, and a screen for a
              TV in the waiting area. Keep the staff link private: anyone with it can call people.
            </p>
            <ul className="mt-5 space-y-2 text-sm text-muted">
              <li>• Several counters at once, and two staff can never call the same person.</li>
              <li>• People who don't show up can be brought back to the front.</li>
              <li>• Customers' names are optional and only staff see them. Finished tickets are deleted after 7 days.</li>
              <li>• Lines nobody uses for 30 days are deleted.</li>
            </ul>
          </div>
          <CreateForm />
        </section>

        <JoinByCode />
      </main>
      <Footer />
    </div>
  );
}

function CreateForm() {
  const [name, setName] = useState("");
  const [counters, setCounters] = useState("Counter 1");
  const [minutes, setMinutes] = useState(5);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const list = counters
      .split(",")
      .map((c) => c.trim())
      .filter(Boolean);
    if (!name.trim()) return setError("Give the line a name, like the place it's for.");
    if (list.length === 0) return setError("Add at least one counter.");
    if (list.length > LIMITS.counters) return setError(`Up to ${LIMITS.counters} counters.`);
    setBusy(true);
    setError(null);
    try {
      const { code, staffKey } = await createQueue({ name: name.trim(), counters: list, serviceMinutes: minutes });
      saveStaffKey(code, staffKey);
      navigate(`/q/${code}/staff`);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Couldn't create the line. Try again.");
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="card space-y-4 p-6">
      <div>
        <label className="label" htmlFor="name">
          Name
        </label>
        <input
          id="name"
          className="input"
          placeholder="Dr. Mehta's Clinic"
          maxLength={LIMITS.queueName}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </div>
      <div>
        <label className="label" htmlFor="counters">
          Counters
        </label>
        <input
          id="counters"
          className="input"
          placeholder="Room 1, Room 2"
          value={counters}
          onChange={(e) => setCounters(e.target.value)}
        />
        <p className="mt-1.5 text-xs text-muted">Separate with commas: rooms, desks, chairs, interview panels.</p>
      </div>
      <div>
        <label className="label" htmlFor="minutes">
          Minutes per person, roughly
        </label>
        <input
          id="minutes"
          className="input"
          type="number"
          min={LIMITS.serviceMinutes.min}
          max={LIMITS.serviceMinutes.max}
          value={minutes}
          onChange={(e) => setMinutes(Math.max(1, Math.min(120, Number(e.target.value) || 1)))}
        />
        <p className="mt-1.5 text-xs text-muted">Only a starting point: the estimate learns from real service times.</p>
      </div>
      {error && <Notice tone="danger">{error}</Notice>}
      <button type="submit" className="btn-primary w-full py-3" disabled={busy}>
        {busy ? "Creating…" : "Create the line"}
      </button>
    </form>
  );
}

function JoinByCode() {
  const [code, setCode] = useState("");
  const valid = /^[2-9A-HJKMNP-Z]{6}$/.test(code);
  return (
    <section className="py-8">
      <form
        className="card flex flex-col gap-3 p-5 sm:flex-row sm:items-end"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) navigate(`/q/${code}`);
        }}
      >
        <div className="flex-1">
          <label className="label" htmlFor="code">
            Have a code instead of a QR?
          </label>
          <input
            id="code"
            className="input font-mono uppercase tracking-[0.3em]"
            placeholder="ABC234"
            maxLength={6}
            autoComplete="off"
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))}
          />
        </div>
        <button type="submit" className="btn-secondary py-3" disabled={!valid}>
          Join the line
        </button>
      </form>
    </section>
  );
}

/** A static picture of the customer's screen, so the idea lands before anyone clicks. */
function PhonePreview() {
  return (
    <div className="mx-auto w-full max-w-[300px]" aria-hidden="true">
      <div className="rounded-[2.5rem] border-[10px] border-ink bg-ink shadow-2xl">
        <div className="overflow-hidden rounded-[1.8rem] bg-canvas">
          <div className="flex items-center justify-between px-5 pt-4 text-xs text-muted">
            <span>Sunrise Clinic</span>
            <span className="pill bg-brand-soft px-2 py-0.5 text-brand">● Live</span>
          </div>
          <div className="px-5 pb-6 pt-6 text-center">
            <p className="text-xs font-medium uppercase tracking-widest text-muted">Your number</p>
            <p className="tabular text-7xl font-bold tracking-tight">42</p>
            <p className="mt-3 text-lg font-semibold">3 people ahead of you</p>
            <p className="text-sm text-muted">about 9–17 min</p>
            <div className="mt-5 grid grid-cols-2 gap-2 text-left text-xs">
              <div className="rounded-xl bg-surface p-3">
                <p className="text-muted">Room 1</p>
                <p className="tabular text-xl font-bold">38</p>
              </div>
              <div className="rounded-xl bg-surface p-3">
                <p className="text-muted">Room 2</p>
                <p className="tabular text-xl font-bold">39</p>
              </div>
            </div>
          </div>
          <div className="bg-brand px-5 py-3 text-center text-sm font-semibold text-white">You'll get a chime when it's your turn</div>
        </div>
      </div>
    </div>
  );
}
