// What a browser remembers between visits. Storage can be unavailable (private windows, blocked
// site data), so every access is guarded and the app works without it, minus the memory.

function read(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string | null): void {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    // Not remembered; the session still works.
  }
}

let fallbackDevice: string | null = null;

/** A random id for this browser. It's the customer's credential for their ticket. */
export function deviceId(): string {
  const stored = read("lineless:device");
  if (stored) return stored;
  const id = fallbackDevice ?? crypto.randomUUID();
  fallbackDevice = id;
  write("lineless:device", id);
  return id;
}

export interface SavedTicket {
  id: string;
  number: number;
}

export function savedTicket(code: string): SavedTicket | null {
  const raw = read(`lineless:ticket:${code}`);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as SavedTicket;
    return typeof parsed.id === "string" && typeof parsed.number === "number" ? parsed : null;
  } catch {
    return null;
  }
}

export function saveTicket(code: string, ticket: SavedTicket | null): void {
  write(`lineless:ticket:${code}`, ticket ? JSON.stringify(ticket) : null);
}

export function staffKey(code: string): string | null {
  return read(`lineless:staff:${code}`);
}

export function saveStaffKey(code: string, key: string): void {
  write(`lineless:staff:${code}`, key);
}

export function savedCounter(code: string): string | null {
  return read(`lineless:counter:${code}`);
}

export function saveCounter(code: string, counterId: string): void {
  write(`lineless:counter:${code}`, counterId);
}
