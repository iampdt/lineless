import { type FormEvent, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { LIMITS, type QueueView, type YouView } from "../../shared/protocol";
import { askForNotifications, buzz, chime, keepScreenOn, notify, releaseScreen, unlockSound } from "../lib/alerts";
import { ApiError, sendCommand } from "../lib/api";
import { formatWait } from "../lib/format";
import { useQueue } from "../lib/socket";
import { deviceId, savedTicket, saveTicket, type SavedTicket } from "../lib/storage";
import { Centered, ConnectionBadge, Logo, Notice, useNow } from "../components/ui";
import { Link } from "../router";

/** The customer's page: join, wait, get called. `embedded` is the demo's phone frame. */
export function Join({ code, embedded = false }: { code: string; embedded?: boolean }) {
  const device = useMemo(deviceId, []);
  const [ticket, setTicket] = useState<SavedTicket | null>(() => savedTicket(code));
  const hello = ticket ? { ticket: { id: ticket.id, device } } : null;
  const { queue, you, connection, denied, receivedAt } = useQueue(code, hello);

  // A ticket this device no longer owns (storage copied, or the queue was reset) is forgotten.
  useEffect(() => {
    if (denied === "unknown_ticket") {
      saveTicket(code, null);
      setTicket(null);
    }
  }, [denied, code]);

  const forget = () => {
    saveTicket(code, null);
    setTicket(null);
    releaseScreen();
  };

  if (connection === "gone") {
    return (
      <Shell embedded={embedded}>
        <Centered>
          <h1 className="text-2xl font-bold">This line has ended</h1>
          <p className="text-muted">It was closed and deleted. If you're still waiting somewhere, ask at the desk.</p>
          <Link to="/" className="btn-secondary">
            About Lineless
          </Link>
        </Centered>
      </Shell>
    );
  }

  if (!queue) {
    return (
      <Shell embedded={embedded}>
        <Centered>
          <p className="text-muted">{connection === "reconnecting" ? "Can't reach the line. Retrying…" : "Loading the line…"}</p>
        </Centered>
      </Shell>
    );
  }

  return (
    <Shell embedded={embedded} queue={queue} connection={connection}>
      {ticket && you ? (
        <TicketScreen code={code} queue={queue} receivedAt={receivedAt} you={you} device={device} onForget={forget} />
      ) : ticket && you === undefined ? (
        <Centered>
          <p className="text-muted">Finding your ticket…</p>
        </Centered>
      ) : ticket && you === null ? (
        <Centered>
          <h1 className="text-2xl font-bold">Ticket {ticket.number} has finished</h1>
          <button type="button" className="btn-primary" onClick={forget}>
            Join again
          </button>
        </Centered>
      ) : (
        <JoinForm
          code={code}
          queue={queue}
          receivedAt={receivedAt}
          device={device}
          onJoined={(t) => {
            saveTicket(code, t);
            setTicket(t);
          }}
        />
      )}
    </Shell>
  );
}

function Shell({
  children,
  queue,
  connection,
  embedded,
}: {
  children: ReactNode;
  queue?: QueueView;
  connection?: Parameters<typeof ConnectionBadge>[0]["connection"];
  embedded: boolean;
}) {
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="flex items-center justify-between gap-3 px-4 pt-4">
        <div className="min-w-0">
          {embedded ? null : <Logo className="mb-1 text-sm text-muted" />}
          {queue && <p className="truncate font-semibold">{queue.name}</p>}
        </div>
        {connection && <ConnectionBadge connection={connection} />}
      </header>
      {queue?.demo && !embedded && (
        <div className="mx-4 mt-3">
          <Notice>This is a demo line with simulated customers.</Notice>
        </div>
      )}
      <main className="flex flex-1 flex-col px-4 pb-6 pt-4">{children}</main>
    </div>
  );
}

function JoinForm({
  code,
  queue,
  receivedAt,
  device,
  onJoined,
}: {
  code: string;
  queue: QueueView;
  receivedAt: number;
  device: string;
  onJoined: (ticket: SavedTicket) => void;
}) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ahead = queue.waiting.length;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    unlockSound(); // this tap is the gesture that lets the page chime later
    setBusy(true);
    setError(null);
    try {
      const result = await sendCommand(code, { type: "join", device, name: name.trim() || undefined });
      if (result.type === "joined") onJoined(result.ticket);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Couldn't join. Try again.");
    } finally {
      setBusy(false);
    }
  };

  if (queue.status !== "open") {
    return (
      <Centered>
        <h1 className="text-2xl font-bold">{queue.status === "paused" ? "Not taking new people right now" : "This line is closed"}</h1>
        <p className="text-muted">
          {queue.status === "paused" ? "Try again in a little while, or ask at the desk." : "Ask at the desk when it opens."}
        </p>
      </Centered>
    );
  }

  return (
    <form onSubmit={submit} className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center gap-6">
      <div className="text-center">
        <p className="text-sm font-medium uppercase tracking-widest text-muted">Waiting now</p>
        <p className="tabular text-6xl font-bold">{ahead}</p>
        <p className="mt-2 text-muted">
          {ahead === 0 ? "You'd be next." : `If you join now: ${formatWait(ahead + 1, queue.pace, receivedAt)}`}
        </p>
      </div>
      <div>
        <label className="label" htmlFor="customer-name">
          Your name <span className="font-normal text-muted">(optional, only staff see it)</span>
        </label>
        <input
          id="customer-name"
          className="input"
          autoComplete="given-name"
          maxLength={LIMITS.customerName}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </div>
      {error && <Notice tone="danger">{error}</Notice>}
      <button type="submit" className="btn-primary py-4 text-lg" disabled={busy}>
        {busy ? "Joining…" : "Join the line"}
      </button>
      <NowServing queue={queue} />
    </form>
  );
}

function TicketScreen({
  code,
  queue,
  receivedAt,
  you,
  device,
  onForget,
}: {
  code: string;
  queue: QueueView;
  receivedAt: number;
  you: YouView;
  device: string;
  onForget: () => void;
}) {
  const [leaving, setLeaving] = useState(false);
  const alerted = useRef<string | null>(null);
  const now = useNow(15_000);

  // Alert once per call and once per recall, not on every snapshot.
  useEffect(() => {
    if (you.status !== "called") return;
    const key = `${you.id}:${you.recalls}`;
    if (alerted.current === key) return;
    alerted.current = key;
    chime();
    buzz();
    notify(`It's your turn — ${you.counterName ?? "the counter"}`, `Number ${you.number}, ${queue.name}`);
  }, [you, queue.name]);

  // Release the wake lock once the wait is over.
  useEffect(() => {
    if (you.status !== "waiting" && you.status !== "called") releaseScreen();
  }, [you.status]);

  const leave = async () => {
    setLeaving(true);
    try {
      await sendCommand(code, { type: "leave", ticketId: you.id, device });
    } catch {
      setLeaving(false);
    }
  };

  if (you.status === "called") {
    return (
      <div className="-mx-4 -mb-6 flex flex-1 flex-col items-center justify-center gap-6 bg-brand px-6 py-10 text-center text-white" role="alert">
        <p className="text-lg font-semibold uppercase tracking-widest opacity-80">It's your turn</p>
        <div className="pulse-ring flex h-44 w-44 items-center justify-center rounded-full bg-white/15">
          <span className="tabular text-7xl font-bold">{you.number}</span>
        </div>
        <p className="text-4xl font-bold">{you.counterName ? `Go to ${you.counterName}` : "Please come to the desk"}</p>
        {you.recalls > 0 && <p className="text-white/80">They're calling you again.</p>}
      </div>
    );
  }

  if (you.status === "waiting") {
    const position = you.position ?? 1;
    return (
      <div className="mx-auto flex w-full max-w-sm flex-1 flex-col gap-6">
        <div className="pt-4 text-center">
          <p className="text-sm font-medium uppercase tracking-widest text-muted">Your number</p>
          <p className="tabular text-8xl font-bold tracking-tight">{you.number}</p>
          <p className="mt-4 text-2xl font-semibold" aria-live="polite">
            {position === 1 ? "You're next" : `${position - 1} ${position === 2 ? "person" : "people"} ahead of you`}
          </p>
          <p className="mt-1 text-muted">{formatWait(position, queue.pace, receivedAt, now)}</p>
        </div>
        <NowServing queue={queue} />
        <AlertSetup />
        <button type="button" className="btn-quiet mt-auto" onClick={leave} disabled={leaving}>
          {leaving ? "Leaving…" : "Leave the line"}
        </button>
      </div>
    );
  }

  const done: Record<string, [string, string]> = {
    served: ["You're all done", "Thanks for waiting."],
    missed: ["You missed your turn", "Talk to the desk: they can put you back at the front of the line."],
    left: ["You left the line", "Your place has gone to the next person."],
    cleared: ["The line was closed", "Staff cleared the line. Ask at the desk if you still need help."],
  };
  const [title, body] = done[you.status] ?? ["Your ticket has finished", ""];
  return (
    <Centered>
      <p className="tabular text-5xl font-bold text-muted">{you.number}</p>
      <h1 className="text-2xl font-bold">{title}</h1>
      <p className="text-muted">{body}</p>
      {you.status !== "missed" && (
        <button type="button" className="btn-primary" onClick={onForget}>
          Join again
        </button>
      )}
    </Centered>
  );
}

function NowServing({ queue }: { queue: QueueView }) {
  return (
    <div className="grid grid-cols-2 gap-2">
      {queue.counters.map((counter) => (
        <div key={counter.id} className="card px-4 py-3">
          <p className="truncate text-xs text-muted">{counter.name}</p>
          <p className="tabular text-2xl font-bold">{counter.serving ?? "—"}</p>
        </div>
      ))}
    </div>
  );
}

/** Ask for what we need to reach the person: sound, notifications, and a screen that stays on. */
function AlertSetup() {
  const [enabled, setEnabled] = useState(false);
  const enable = async () => {
    unlockSound();
    chime();
    await Promise.all([askForNotifications(), keepScreenOn()]);
    setEnabled(true);
  };
  if (enabled) {
    return <Notice>Alerts on. Keep this page open; we'll chime and vibrate when it's your turn.</Notice>;
  }
  return (
    <button type="button" className="btn-secondary py-3" onClick={enable}>
      Turn on alerts
    </button>
  );
}
