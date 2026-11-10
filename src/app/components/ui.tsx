import { type ReactNode, useEffect, useState } from "react";
import QRCode from "qrcode";
import { Link } from "../router";
import type { Connection } from "../lib/socket";

export const SOURCE_URL = "https://github.com/iampdt/lineless";
export const AUTHOR_URL = "https://pdt001.vercel.app";

export function Logo({ className = "" }: { className?: string }) {
  return (
    <span className={`inline-flex items-center gap-2 font-semibold tracking-tight ${className}`}>
      <svg viewBox="0 0 64 64" className="h-7 w-7" aria-hidden="true">
        <rect width="64" height="64" rx="14" fill="#0d7a5f" />
        <circle cx="20" cy="32" r="6" fill="#fff" opacity=".45" />
        <circle cx="32" cy="32" r="6" fill="#fff" opacity=".7" />
        <circle cx="44" cy="32" r="7.5" fill="#fff" />
      </svg>
      Lineless
    </span>
  );
}

export function Header({ children }: { children?: ReactNode }) {
  return (
    <header className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-4 sm:px-6">
      <Link to="/" className="text-lg">
        <Logo />
      </Link>
      <div className="flex items-center gap-2">{children}</div>
    </header>
  );
}

export function Footer() {
  return (
    <footer className="mx-auto max-w-6xl px-4 py-10 text-sm text-muted sm:px-6">
      <div className="flex flex-col gap-2 border-t border-line pt-6 sm:flex-row sm:justify-between">
        <span>
          Built by{" "}
          <a className="font-medium text-ink underline-offset-4 hover:underline" href={AUTHOR_URL}>
            Paras Dev Tyagi
          </a>
        </span>
        <span className="flex gap-4">
          <a className="hover:text-ink" href={`${SOURCE_URL}#how-it-works`}>
            How it works
          </a>
          <a className="hover:text-ink" href={SOURCE_URL}>
            Source on GitHub
          </a>
        </span>
      </div>
    </footer>
  );
}

export function Qr({ value, className = "", dark = false }: { value: string; className?: string; dark?: boolean }) {
  const [svg, setSvg] = useState("");
  useEffect(() => {
    let cancelled = false;
    QRCode.toString(value, {
      type: "svg",
      margin: 1,
      errorCorrectionLevel: "M",
      color: dark ? { dark: "#ffffff", light: "#00000000" } : { dark: "#15171c", light: "#ffffff" },
    })
      .then((text) => !cancelled && setSvg(text))
      .catch(() => setSvg(""));
    return () => {
      cancelled = true;
    };
  }, [value, dark]);
  // The SVG comes from the QR library, generated from our own URL.
  return <div role="img" aria-label={`QR code for ${value}`} className={className} dangerouslySetInnerHTML={{ __html: svg }} />;
}

export function ConnectionBadge({ connection }: { connection: Connection }) {
  if (connection === "live") {
    return (
      <span className="pill bg-brand-soft text-brand">
        <span className="h-1.5 w-1.5 rounded-full bg-brand" /> Live
      </span>
    );
  }
  if (connection === "gone" || connection === "denied") return null;
  return (
    <span className="pill bg-warn-soft text-warn" role="status">
      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-warn" />
      {connection === "connecting" ? "Connecting…" : "Reconnecting…"}
    </span>
  );
}

/** Re-render every `ms` so relative times stay fresh. */
export function useNow(ms = 15_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(timer);
  }, [ms]);
  return now;
}

export function CopyButton({ text, label, className = "btn-secondary" }: { text: string; label: string; className?: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setState("copied");
    } catch {
      setState("failed");
    }
    setTimeout(() => setState("idle"), 2000);
  };
  return (
    <button type="button" className={className} onClick={copy} title={text}>
      {state === "copied" ? "Copied" : state === "failed" ? "Couldn't copy" : label}
    </button>
  );
}

export function Notice({ tone = "neutral", children }: { tone?: "neutral" | "warn" | "danger"; children: ReactNode }) {
  const styles = {
    neutral: "border-line bg-surface text-ink",
    warn: "border-warn/30 bg-warn-soft text-warn",
    danger: "border-danger/30 bg-danger-soft text-danger",
  }[tone];
  return <div className={`rounded-xl border px-4 py-3 text-sm ${styles}`}>{children}</div>;
}

export function Centered({ children }: { children: ReactNode }) {
  return <div className="mx-auto flex min-h-[60vh] max-w-md flex-col items-center justify-center gap-4 px-4 text-center">{children}</div>;
}
