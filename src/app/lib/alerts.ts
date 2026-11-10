// Getting someone's attention when it's their turn, with what a web page is allowed to do:
// a chime (after the person has tapped something, as browsers require), vibration where the
// phone supports it, a notification when the page is in the background, and a screen wake lock
// so the page, and its connection, stay alive while they wait.

let audio: AudioContext | null = null;

/** Call from a click or tap: browsers only allow sound after a user gesture. */
export function unlockSound(): void {
  try {
    audio ??= new AudioContext();
    if (audio.state === "suspended") void audio.resume();
  } catch {
    audio = null;
  }
}

export function soundUnlocked(): boolean {
  return audio !== null && audio.state === "running";
}

export function chime(): void {
  if (!audio || audio.state !== "running") return;
  const start = audio.currentTime;
  for (const [offset, frequency] of [
    [0, 880],
    [0.18, 1318.5],
  ] as const) {
    const oscillator = audio.createOscillator();
    const gain = audio.createGain();
    oscillator.type = "sine";
    oscillator.frequency.value = frequency;
    gain.gain.setValueAtTime(0.0001, start + offset);
    gain.gain.exponentialRampToValueAtTime(0.3, start + offset + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + offset + 0.6);
    oscillator.connect(gain).connect(audio.destination);
    oscillator.start(start + offset);
    oscillator.stop(start + offset + 0.65);
  }
}

export function buzz(): void {
  try {
    navigator.vibrate?.([300, 120, 300, 120, 500]);
  } catch {
    // Not supported.
  }
}

export function notificationsSupported(): boolean {
  return typeof Notification !== "undefined";
}

export async function askForNotifications(): Promise<boolean> {
  if (!notificationsSupported()) return false;
  if (Notification.permission === "granted") return true;
  if (Notification.permission === "denied") return false;
  return (await Notification.requestPermission()) === "granted";
}

export function notify(title: string, body: string): void {
  if (!notificationsSupported() || Notification.permission !== "granted" || !document.hidden) return;
  try {
    new Notification(title, { body, tag: "lineless-turn", requireInteraction: true });
  } catch {
    // Some mobile browsers only allow notifications from a service worker.
  }
}

let wakeLock: WakeLockSentinel | null = null;
let wakeWanted = false;

/** Keep the screen on while waiting; re-acquired when the page becomes visible again. */
export async function keepScreenOn(): Promise<boolean> {
  wakeWanted = true;
  try {
    wakeLock = (await navigator.wakeLock?.request("screen")) ?? null;
    return wakeLock !== null;
  } catch {
    return false;
  }
}

export function releaseScreen(): void {
  wakeWanted = false;
  void wakeLock?.release();
  wakeLock = null;
}

if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (wakeWanted && document.visibilityState === "visible") void keepScreenOn();
  });
}
