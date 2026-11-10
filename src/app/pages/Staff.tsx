import { useEffect, useState } from "react";
import { type CommandResult, type Command, LIMITS, type QueueStatus, type QueueView, type StaffView, type TicketView } from "../../shared/protocol";
import { ApiError, sendCommand } from "../lib/api";
import { ago, formatWait, joinUrl, seconds, since } from "../lib/format";
import { useQueue } from "../lib/socket";
import { savedCounter, saveCounter, saveStaffKey, staffKey as storedStaffKey } from "../lib/storage";
import { Centered, ConnectionBadge, CopyButton, Header, Notice, Qr, useNow } from "../components/ui";
import { Link } from "../router";

/** The staff key arrives in the URL fragment (never sent to a server), then moves to storage. */
function useStaffKey(code: string): string | null {
  const [key] = useState(() => {
    const fromLink = new URLSearchParams(window.location.hash.slice(1)).get("key");
    if (fromLink) {
      saveStaffKey(code, fromLink);
      window.history.replaceState(null, "", window.location.pathname);
      return fromLink;
    }
    return storedStaffKey(code);
  });
  return key;
}

export function Staff({ code }: { code: string }) {
  const key = useStaffKey(code);
  const { queue, staff, connection, denied, receivedAt } = useQueue(code, key ? { staffKey: key } : null);

  if (!key || denied === "bad_key") {
    return (
      <Centered>
        <h1 className="text-2xl font-bold">This page needs the staff link</h1>
        <p className="text-muted">
          Open the staff link you got when the line was created. Waiting customers use the{" "}
          <Link to={`/q/${code}`} className="font-medium text-brand underline-offset-4 hover:underline">
            customer page
          </Link>
          .
        </p>
      </Centered>
    );
  }
  if (connection === "gone") {
    return (
      <Centered>
        <h1 className="text-2xl font-bold">This line has been deleted</h1>
        <Link to="/" className="btn-primary">
          Start a new one
        </Link>
      </Centered>
    );
  }
  if (!queue || !staff) {
    return (
      <Centered>
        <p className="text-muted">{connection === "reconnecting" ? "Can't reach the line. Retrying…" : "Loading…"}</p>
      </Centered>
    );
  }

  return (
    <div className="min-h-screen">
      <Header>
        <ConnectionBadge connection={connection} />
      </Header>
      <main className="mx-auto max-w-6xl px-4 pb-10 sm:px-6">
        <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className="text-sm text-muted">
              Staff screen · code <span className="font-mono font-semibold tracking-widest text-ink">{code}</span>
            </p>
            <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">{queue.name}</h1>
          </div>
          <StatusControl code={code} staffKey={key} queue={queue} waiting={staff.waiting.length} />
        </div>

        {queue.demo && <DemoGuide code={code} staffKey={key} staff={staff} />}

        <div className="grid gap-5 lg:grid-cols-[1fr_340px]">
          <div className="space-y-5">
            <CounterPanel code={code} staffKey={key} queue={queue} staff={staff} />
            <WaitingList queue={queue} staff={staff} receivedAt={receivedAt} />
            {staff.missed.length > 0 && <MissedList code={code} staffKey={key} missed={staff.missed} />}
          </div>
          <aside className="space-y-5">
            {queue.demo ? <DemoPhone code={code} /> : <SharePanel code={code} staffKey={key} />}
            <Stats queue={queue} staff={staff} />
            <CountersEditor code={code} staffKey={key} queue={queue} />
            {queue.demo && <SharePanel code={code} staffKey={key} />}
          </aside>
        </div>
      </main>
    </div>
  );
}

/** Send a staff command, turning failures into a message for the screen. */
function useCommand(code: string, staffKey: string) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!error) return;
    const timer = setTimeout(() => setError(null), 5000);
    return () => clearTimeout(timer);
  }, [error]);
  const run = async (command: Command): Promise<CommandResult | null> => {
    setBusy(true);
    setError(null);
    try {
      return await sendCommand(code, command, staffKey);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "That didn't work. Try again.");
      return null;
    } finally {
      setBusy(false);
    }
  };
  return { run, busy, error };
}

function CounterPanel({ code, staffKey, queue, staff }: { code: string; staffKey: string; queue: QueueView; staff: StaffView }) {
  const [counterId, setCounterId] = useState(() => savedCounter(code));
  const counter = queue.counters.find((c) => c.id === counterId) ?? queue.counters[0]!;
  const current = staff.called.find((t) => t.counterId === counter.id) ?? null;
  const next = staff.waiting[0];
  const { run, busy, error } = useCommand(code, staffKey);
  const now = useNow(10_000);

  const choose = (id: string) => {
    setCounterId(id);
    saveCounter(code, id);
  };

  return (
    <section className="card p-5 sm:p-6">
      {queue.counters.length > 1 && (
        <div className="mb-5">
          <p className="mb-2 text-sm font-medium text-muted">You're at</p>
          <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Counter">
            {queue.counters.map((c) => (
              <button
                key={c.id}
                type="button"
                role="radio"
                aria-checked={c.id === counter.id}
                onClick={() => choose(c.id)}
                className={`rounded-xl border px-3.5 py-2 text-sm font-semibold transition-colors ${
                  c.id === counter.id ? "border-brand bg-brand text-white" : "border-line bg-surface hover:bg-canvas"
                }`}
              >
                {c.name}
                <span className={`tabular ml-2 font-normal ${c.id === counter.id ? "text-white/80" : "text-muted"}`}>
                  {c.serving ?? "free"}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="grid gap-5 sm:grid-cols-[1fr_auto] sm:items-center">
        <div>
          <p className="text-sm font-medium text-muted">Now serving at {counter.name}</p>
          {current ? (
            <div className="mt-1 flex items-baseline gap-3">
              <span className="tabular text-6xl font-bold tracking-tight">{current.number}</span>
              <span className="min-w-0">
                <span className="block truncate text-lg font-semibold">{current.name || "No name"}</span>
                <span className="text-sm text-muted">
                  called {ago(current.calledAt ?? now, now)}
                  {current.recalls > 0 && ` · recalled ${current.recalls}×`}
                </span>
              </span>
            </div>
          ) : (
            <p className="mt-1 text-2xl font-semibold text-faint">Nobody</p>
          )}
        </div>
        <button
          type="button"
          className="btn-primary h-16 px-8 text-lg sm:min-w-56"
          disabled={busy || (!current && !next)}
          onClick={() => run({ type: "call_next", counterId: counter.id, expectServing: current?.id ?? null })}
        >
          {next ? `Call next · ${next.number}` : current ? "Finish, nobody waiting" : "Nobody waiting"}
        </button>
      </div>

      {current && (
        <div className="mt-4 flex flex-wrap gap-2">
          <button type="button" className="btn-secondary" disabled={busy} onClick={() => run({ type: "recall", ticketId: current.id })}>
            Call again
          </button>
          <button type="button" className="btn-secondary" disabled={busy} onClick={() => run({ type: "no_show", ticketId: current.id })}>
            Didn't come
          </button>
          <button type="button" className="btn-secondary" disabled={busy} onClick={() => run({ type: "finish", ticketId: current.id })}>
            Done, take a break
          </button>
        </div>
      )}
      {error && (
        <div className="mt-4">
          <Notice tone="warn">{error}</Notice>
        </div>
      )}
    </section>
  );
}

function WaitingList({ queue, staff, receivedAt }: { queue: QueueView; staff: StaffView; receivedAt: number }) {
  const now = useNow(30_000);
  const shown = staff.waiting.slice(0, 50);
  return (
    <section className="card">
      <div className="flex items-center justify-between border-b border-line px-5 py-4">
        <h2 className="font-semibold">
          Waiting <span className="tabular text-muted">{staff.waiting.length}</span>
        </h2>
        {staff.waiting.length > 0 && (
          <span className="text-sm text-muted">last in line: {formatWait(staff.waiting.length, queue.pace, receivedAt, now)}</span>
        )}
      </div>
      {shown.length === 0 ? (
        <p className="px-5 py-8 text-center text-muted">Nobody's waiting.</p>
      ) : (
        <ol className="divide-y divide-line">
          {shown.map((ticket, index) => (
            <li key={ticket.id} className="flex items-center gap-4 px-5 py-3">
              <span className="w-6 text-right text-sm text-faint">{index + 1}</span>
              <span className="tabular w-12 text-xl font-bold">{ticket.number}</span>
              <span className="min-w-0 flex-1 truncate">{ticket.name || <span className="text-faint">No name</span>}</span>
              <span className="text-sm text-muted">{since(ticket.joinedAt, now)}</span>
            </li>
          ))}
        </ol>
      )}
      {staff.waiting.length > shown.length && (
        <p className="border-t border-line px-5 py-3 text-sm text-muted">and {staff.waiting.length - shown.length} more</p>
      )}
    </section>
  );
}

function MissedList({ code, staffKey, missed }: { code: string; staffKey: string; missed: TicketView[] }) {
  const { run, busy, error } = useCommand(code, staffKey);
  return (
    <section className="card">
      <h2 className="border-b border-line px-5 py-4 font-semibold">Didn't come</h2>
      <ul className="divide-y divide-line">
        {missed.map((ticket) => (
          <li key={ticket.id} className="flex items-center gap-4 px-5 py-3">
            <span className="tabular w-12 text-xl font-bold text-muted">{ticket.number}</span>
            <span className="min-w-0 flex-1 truncate">{ticket.name || <span className="text-faint">No name</span>}</span>
            <button type="button" className="btn-secondary" disabled={busy} onClick={() => run({ type: "bring_back", ticketId: ticket.id })}>
              Back to the front
            </button>
          </li>
        ))}
      </ul>
      {error && (
        <div className="px-5 pb-4">
          <Notice tone="warn">{error}</Notice>
        </div>
      )}
    </section>
  );
}

function StatusControl({ code, staffKey, queue, waiting }: { code: string; staffKey: string; queue: QueueView; waiting: number }) {
  const { run, busy } = useCommand(code, staffKey);
  const [confirmClear, setConfirmClear] = useState(false);
  const options: [QueueStatus, string][] = [
    ["open", "Open"],
    ["paused", "Pause joining"],
    ["closed", "Close"],
  ];
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="inline-flex rounded-xl border border-line bg-surface p-1" role="radiogroup" aria-label="Line status">
        {options.map(([status, label]) => (
          <button
            key={status}
            type="button"
            role="radio"
            aria-checked={queue.status === status}
            disabled={busy}
            onClick={() => run({ type: "set_status", status })}
            className={`rounded-lg px-3 py-1.5 text-sm font-semibold ${
              queue.status === status
                ? status === "open"
                  ? "bg-brand text-white"
                  : "bg-ink text-white"
                : "text-muted hover:text-ink"
            }`}
          >
            {label}
          </button>
        ))}
      </div>
      {queue.status !== "open" && waiting > 0 && (
        <button
          type="button"
          className={confirmClear ? "btn bg-danger text-white" : "btn-secondary"}
          disabled={busy}
          onClick={async () => {
            if (!confirmClear) {
              setConfirmClear(true);
              setTimeout(() => setConfirmClear(false), 4000);
              return;
            }
            setConfirmClear(false);
            await run({ type: "clear_waiting" });
          }}
        >
          {confirmClear ? `Tap again to remove ${waiting}` : "Clear the line"}
        </button>
      )}
    </div>
  );
}

function Stats({ queue, staff }: { queue: QueueView; staff: StaffView }) {
  const { stats } = staff;
  const rows: [string, string][] = [
    ["Served", String(stats.served)],
    ["Average wait", seconds(stats.averageWaitSeconds)],
    ["Average service", seconds(stats.averageServiceSeconds)],
    ["Didn't come", String(stats.missed)],
    ["Left the line", String(stats.left)],
    ["Pace now", `a call every ${seconds(queue.pace.secondsPerTicket)}`],
  ];
  return (
    <section className="card p-5">
      <h2 className="mb-3 font-semibold">Since the line opened</h2>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
        {rows.map(([label, value]) => (
          <div key={label}>
            <dt className="text-muted">{label}</dt>
            <dd className="tabular font-semibold">{value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function SharePanel({ code, staffKey }: { code: string; staffKey: string }) {
  const join = joinUrl(code);
  return (
    <section className="card p-5">
      <h2 className="font-semibold">Let people join</h2>
      <p className="mt-1 text-sm text-muted">Print this QR code or show it on a screen at the door.</p>
      <Qr value={join} className="mx-auto my-4 w-48 [&_svg]:h-auto [&_svg]:w-full" />
      <p className="text-center font-mono text-2xl font-bold tracking-[0.3em]">{code}</p>
      <div className="mt-4 grid gap-2">
        <CopyButton text={join} label="Copy the join link" />
        <a className="btn-secondary" href={`/q/${code}/display`} target="_blank" rel="noreferrer">
          Open the TV screen
        </a>
        <CopyButton text={`${location.origin}/q/${code}/staff#key=${staffKey}`} label="Copy the staff link" className="btn-quiet" />
      </div>
      <p className="mt-2 text-xs text-muted">Only share the staff link with people who run the line.</p>
    </section>
  );
}

function CountersEditor({ code, staffKey, queue }: { code: string; staffKey: string; queue: QueueView }) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<{ id: string | null; name: string }[]>([]);
  const { run, busy, error } = useCommand(code, staffKey);

  const start = () => {
    setRows(queue.counters.map((c) => ({ id: c.id, name: c.name })));
    setOpen(true);
  };
  const save = async () => {
    const result = await run({ type: "set_counters", counters: rows });
    if (result) setOpen(false);
  };

  if (!open) {
    return (
      <button type="button" className="btn-quiet w-full" onClick={start}>
        Edit counters
      </button>
    );
  }
  return (
    <section className="card space-y-3 p-5">
      <h2 className="font-semibold">Counters</h2>
      {rows.map((row, index) => (
        <div key={row.id ?? `new-${index}`} className="flex gap-2">
          <input
            className="input"
            aria-label={`Counter ${index + 1} name`}
            maxLength={LIMITS.counterName}
            value={row.name}
            onChange={(e) => setRows(rows.map((r, i) => (i === index ? { ...r, name: e.target.value } : r)))}
          />
          <button
            type="button"
            className="btn-quiet"
            aria-label={`Remove ${row.name}`}
            disabled={rows.length === 1}
            onClick={() => setRows(rows.filter((_, i) => i !== index))}
          >
            ✕
          </button>
        </div>
      ))}
      {rows.length < LIMITS.counters && (
        <button type="button" className="btn-quiet" onClick={() => setRows([...rows, { id: null, name: `Counter ${rows.length + 1}` }])}>
          + Add a counter
        </button>
      )}
      {error && <Notice tone="warn">{error}</Notice>}
      <div className="flex gap-2">
        <button type="button" className="btn-primary" disabled={busy} onClick={save}>
          Save
        </button>
        <button type="button" className="btn-secondary" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </section>
  );
}

function DemoGuide({ code, staffKey, staff }: { code: string; staffKey: string; staff: StaffView }) {
  const { run, busy } = useCommand(code, staffKey);
  return (
    <div className="mb-5 flex flex-col gap-3 rounded-2xl border border-brand/25 bg-brand-soft p-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="text-sm">
        <p className="font-semibold text-brand">You're the staff in a demo clinic.</p>
        <p className="text-ink/80">
          Join the line on the phone, then press <strong>Call next</strong> until it's the phone's turn. Simulated
          customers keep arriving while this page is open.
        </p>
      </div>
      <label className="flex shrink-0 cursor-pointer items-center gap-2 text-sm font-medium">
        <input
          type="checkbox"
          className="h-4 w-4 accent-brand"
          checked={staff.autoServe}
          disabled={busy}
          onChange={(e) => run({ type: "set_auto_serve", on: e.target.checked })}
        />
        Let the rooms call people on their own
      </label>
    </div>
  );
}

function DemoPhone({ code }: { code: string }) {
  return (
    <section>
      <div className="mx-auto w-[300px] rounded-[2.6rem] border-[10px] border-ink bg-ink shadow-xl">
        <iframe
          title="A customer's phone"
          src={`/q/${code}?embed=1`}
          className="block h-[560px] w-full rounded-[1.9rem] bg-canvas"
        />
      </div>
      <div className="mt-4 flex items-center gap-4 rounded-2xl border border-line bg-surface p-4">
        <Qr value={joinUrl(code)} className="w-24 shrink-0 [&_svg]:h-auto [&_svg]:w-full" />
        <p className="text-sm text-muted">Or scan this with your own phone and join the same line.</p>
      </div>
    </section>
  );
}
