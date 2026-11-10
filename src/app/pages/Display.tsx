import { type ReactNode, useEffect, useRef, useState } from "react";
import type { QueueView } from "../../shared/protocol";
import { chime, soundUnlocked, unlockSound } from "../lib/alerts";
import { formatWait, joinUrl } from "../lib/format";
import { useQueue } from "../lib/socket";
import { ConnectionBadge, Logo, Qr, useNow } from "../components/ui";

/** The waiting-room TV: who's being served where, who's next, and how to join. */
export function Display({ code }: { code: string }) {
  const { queue, connection, receivedAt } = useQueue(code, null);
  const [sound, setSound] = useState(soundUnlocked());
  const flashing = useCallFlash(queue);
  const now = useNow(30_000);

  if (connection === "gone") {
    return <Dark>This line has ended.</Dark>;
  }
  if (!queue) return <Dark>Connecting…</Dark>;

  return (
    <div className="dark flex min-h-dvh flex-col bg-[#0c0f0e] text-white">
      <header className="flex items-center justify-between gap-4 px-8 py-5">
        <div className="flex min-w-0 items-center gap-4">
          <Logo className="hidden shrink-0 text-white/80 sm:inline-flex" />
          <span className="truncate text-2xl font-semibold">{queue.name}</span>
        </div>
        <div className="flex shrink-0 items-center gap-4 whitespace-nowrap">
          {!sound && (
            <button
              type="button"
              className="rounded-lg bg-white/10 px-3 py-1.5 text-sm hover:bg-white/20"
              onClick={() => {
                unlockSound();
                chime();
                setSound(true);
              }}
            >
              Turn on sound
            </button>
          )}
          <ConnectionBadge connection={connection} />
          <span className="tabular text-2xl text-white/70">
            {new Date(now).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
          </span>
        </div>
      </header>

      <main className="grid flex-1 gap-8 px-8 pb-8 lg:grid-cols-[1fr_360px]">
        <section>
          <h2 className="mb-4 text-lg font-semibold uppercase tracking-widest text-white/50">Now serving</h2>
          <div className={`grid gap-4 ${queue.counters.length > 2 ? "sm:grid-cols-3" : "sm:grid-cols-2"}`}>
            {queue.counters.map((counter) => (
              <div
                key={counter.id}
                className={`rounded-3xl border border-white/10 bg-white/5 p-6 ${flashing.has(counter.id) ? "flash" : ""}`}
              >
                <p className="truncate text-2xl text-white/70">{counter.name}</p>
                <p className="tabular text-[clamp(4rem,9vw,9rem)] font-bold leading-none">{counter.serving ?? "—"}</p>
              </div>
            ))}
          </div>
          <h2 className="mb-3 mt-10 text-lg font-semibold uppercase tracking-widest text-white/50">Next up</h2>
          <div className="flex flex-wrap gap-3">
            {queue.waiting.length === 0 ? (
              <p className="text-2xl text-white/50">Nobody waiting</p>
            ) : (
              queue.waiting.slice(0, 10).map((n) => (
                <span key={n} className="tabular rounded-2xl bg-white/10 px-5 py-3 text-4xl font-bold">
                  {n}
                </span>
              ))
            )}
          </div>
        </section>

        <aside className="flex flex-col items-center justify-center rounded-3xl bg-white/5 p-8 text-center">
          {queue.status === "open" ? (
            <>
              <p className="text-3xl font-bold">Scan to join</p>
              {/* Dark modules on white: some phone cameras don't read inverted codes. */}
              <Qr value={joinUrl(code)} className="my-6 w-64 rounded-2xl bg-white p-3 [&_svg]:h-auto [&_svg]:w-full" />
              <p className="text-white/70">or open {location.host} and enter</p>
              <p className="mt-1 font-mono text-4xl font-bold tracking-[0.3em]">{code}</p>
              <p className="mt-6 text-lg text-white/70">
                {queue.waiting.length} waiting
                {queue.waiting.length > 0 && ` · ${formatWait(queue.waiting.length + 1, queue.pace, receivedAt, now)}`}
              </p>
            </>
          ) : (
            <p className="text-3xl font-bold">{queue.status === "paused" ? "Not taking new people right now" : "Closed"}</p>
          )}
        </aside>
      </main>
    </div>
  );
}

/** Counters whose ticket just changed or was recalled; chimes once per change. */
function useCallFlash(queue: QueueView | null): Set<string> {
  const previous = useRef<Map<string, string> | null>(null);
  const [flashing, setFlashing] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (!queue) return;
    const current = new Map(queue.counters.map((c) => [c.id, `${c.serving}:${c.recalls}`]));
    if (previous.current) {
      const changed = queue.counters
        .filter((c) => c.serving !== null && previous.current?.get(c.id) !== current.get(c.id))
        .map((c) => c.id);
      if (changed.length > 0) {
        chime();
        setFlashing(new Set(changed));
        const timer = setTimeout(() => setFlashing(new Set()), 4000);
        previous.current = current;
        return () => clearTimeout(timer);
      }
    }
    previous.current = current;
  }, [queue]);
  return flashing;
}

function Dark({ children }: { children: ReactNode }) {
  return <div className="flex min-h-dvh items-center justify-center bg-[#0c0f0e] text-2xl text-white/70">{children}</div>;
}
