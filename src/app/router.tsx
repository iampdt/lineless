// Four pages don't need a router library: match the path, render the page.

import { type MouseEvent, type ReactNode, useSyncExternalStore } from "react";

const NAVIGATE = "lineless:navigate";

function subscribe(callback: () => void): () => void {
  window.addEventListener("popstate", callback);
  window.addEventListener(NAVIGATE, callback);
  return () => {
    window.removeEventListener("popstate", callback);
    window.removeEventListener(NAVIGATE, callback);
  };
}

export function usePath(): string {
  return useSyncExternalStore(subscribe, () => window.location.pathname);
}

export function navigate(to: string, { replace = false } = {}): void {
  if (replace) window.history.replaceState(null, "", to);
  else window.history.pushState(null, "", to);
  window.dispatchEvent(new Event(NAVIGATE));
  window.scrollTo(0, 0);
}

export function Link({ to, className, children }: { to: string; className?: string; children: ReactNode }) {
  const onClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
    event.preventDefault();
    navigate(to);
  };
  return (
    <a href={to} className={className} onClick={onClick}>
      {children}
    </a>
  );
}

export type Route =
  | { page: "home" }
  | { page: "join"; code: string }
  | { page: "staff"; code: string }
  | { page: "display"; code: string }
  | { page: "missing" };

export function match(path: string): Route {
  if (path === "/" || path === "") return { page: "home" };
  const queue = /^\/q\/([A-Za-z0-9]{6})(?:\/(staff|display))?\/?$/.exec(path);
  if (!queue) return { page: "missing" };
  const code = queue[1]!.toUpperCase();
  if (queue[2] === "staff") return { page: "staff", code };
  if (queue[2] === "display") return { page: "display", code };
  return { page: "join", code };
}
