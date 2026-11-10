import { joinUrl } from "../lib/format";
import { useQueue } from "../lib/socket";
import { Centered, Logo, Qr } from "../components/ui";

/** A one-page poster for the door or the reception desk, sized for A4 or Letter. */
export function Poster({ code }: { code: string }) {
  const { queue, connection } = useQueue(code, null);

  if (connection === "gone") {
    return (
      <Centered>
        <p className="text-muted">This line has been deleted.</p>
      </Centered>
    );
  }

  return (
    <div className="min-h-screen bg-white print:min-h-0">
      <style>{"@page { size: auto; margin: 12mm; }"}</style>
      <div className="mx-auto flex max-w-[720px] justify-end gap-2 px-6 pt-6 print:hidden">
        <button type="button" className="btn-primary" onClick={() => window.print()}>
          Print
        </button>
      </div>
      <main className="mx-auto flex max-w-[720px] flex-col items-center px-6 py-10 text-center print:py-0">
        <p className="text-2xl font-semibold text-muted">{queue?.name ?? " "}</p>
        <h1 className="mt-4 text-6xl font-bold leading-tight tracking-tight">
          Skip the line.
          <br />
          Scan to join.
        </h1>
        <Qr value={joinUrl(code)} className="mt-10 w-[340px] max-w-full [&_svg]:h-auto [&_svg]:w-full" />
        <ol className="mt-10 grid w-full gap-4 text-left text-xl sm:grid-cols-3 print:grid-cols-3">
          {[
            ["1", "Point your phone's camera at the code"],
            ["2", "See your number and how long it'll be"],
            ["3", "Wait anywhere nearby. Your phone tells you when it's your turn"],
          ].map(([n, text]) => (
            <li key={n} className="flex gap-3">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand font-bold text-white">{n}</span>
              <span>{text}</span>
            </li>
          ))}
        </ol>
        <p className="mt-10 text-lg text-muted">
          No app, no sign-up. No camera? Go to <span className="font-semibold text-ink">{location.host}</span> and enter
        </p>
        <p className="mt-2 font-mono text-5xl font-bold tracking-[0.3em]">{code}</p>
        <Logo className="mt-12 text-base text-faint" />
      </main>
    </div>
  );
}
