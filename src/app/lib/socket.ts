// A live connection to one queue. Phones lose their connection all the time: the screen locks,
// the train enters a tunnel, the browser freezes a background tab. So this hook assumes the
// socket will die and plans for it:
//
// - every message is a full snapshot with a version, so a reconnect needs no catch-up protocol:
//   the first message after it is the current state;
// - a keep-alive every 20 s, and a socket that's heard nothing for 50 s is treated as dead,
//   because a half-open connection never fires `close` on its own;
// - reconnects back off with jitter, and happen at once when the page becomes visible again or
//   the network comes back.

import { useEffect, useRef, useState } from "react";
import { type ClientMessage, PING, type QueueView, type ServerMessage, type StaffView, type YouView } from "../../shared/protocol";

export type Connection = "connecting" | "live" | "reconnecting" | "gone" | "denied";

export interface QueueConnection {
  queue: QueueView | null;
  staff: StaffView | null;
  you: YouView | null | undefined;
  connection: Connection;
  denied: "bad_key" | "unknown_ticket" | null;
  /** When the latest snapshot arrived, for countdowns between updates. */
  receivedAt: number;
}

const PING_EVERY_MS = 20_000;
const DEAD_AFTER_MS = 50_000;
const MAX_BACKOFF_MS = 10_000;

export function useQueue(code: string, hello: Omit<ClientMessage, "type"> | null): QueueConnection {
  const [snapshot, setSnapshot] = useState<QueueConnection>({
    queue: null,
    staff: null,
    you: undefined,
    connection: "connecting",
    denied: null,
    receivedAt: 0,
  });
  // The hello is re-sent on every reconnect; a change to it reconnects.
  const helloKey = JSON.stringify(hello);
  const helloRef = useRef(hello);
  helloRef.current = hello;

  useEffect(() => {
    let socket: WebSocket | null = null;
    let stopped = false;
    let attempt = 0;
    let lastHeard = 0;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let version = 0;

    const url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/q/${code}/ws`;

    const connect = () => {
      if (stopped) return;
      clearTimeout(retryTimer);
      const ws = new WebSocket(url);
      socket = ws;
      lastHeard = Date.now();

      ws.onopen = () => {
        if (helloRef.current) ws.send(JSON.stringify({ type: "hello", ...helloRef.current } satisfies ClientMessage));
      };

      ws.onmessage = (event) => {
        lastHeard = Date.now();
        if (typeof event.data !== "string" || event.data === '{"type":"pong"}') return;
        const message = JSON.parse(event.data) as ServerMessage;
        if (message.type === "gone") {
          stopped = true;
          setSnapshot((s) => ({ ...s, connection: "gone" }));
          ws.close();
          return;
        }
        if (message.type === "denied") {
          setSnapshot((s) => ({ ...s, connection: "denied", denied: message.reason }));
          return;
        }
        attempt = 0;
        // A late snapshot from an older socket must not overwrite a newer one.
        if (message.queue.version < version) return;
        version = message.queue.version;
        setSnapshot((s) => ({
          queue: message.queue,
          staff: message.staff ?? s.staff,
          you: message.you !== undefined ? message.you : s.you,
          connection: s.connection === "denied" ? "denied" : "live",
          denied: s.denied,
          receivedAt: Date.now(),
        }));
      };

      ws.onclose = () => {
        if (socket !== ws || stopped) return;
        socket = null;
        setSnapshot((s) => (s.connection === "gone" ? s : { ...s, connection: "reconnecting" }));
        const delay = Math.min(MAX_BACKOFF_MS, 500 * 2 ** attempt) * (0.5 + Math.random() / 2);
        attempt += 1;
        retryTimer = setTimeout(connect, delay);
      };
    };

    const reconnectNow = () => {
      if (stopped) return;
      if (!socket || socket.readyState === WebSocket.CLOSED || socket.readyState === WebSocket.CLOSING) {
        attempt = 0;
        connect();
      }
    };

    const heartbeat = setInterval(() => {
      if (!socket || socket.readyState !== WebSocket.OPEN) return;
      if (Date.now() - lastHeard > DEAD_AFTER_MS) {
        socket.close(); // half-open: force the reconnect path
        return;
      }
      socket.send(PING);
    }, PING_EVERY_MS);

    const onVisible = () => {
      if (document.visibilityState === "visible") reconnectNow();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", reconnectNow);

    connect();

    return () => {
      stopped = true;
      clearTimeout(retryTimer);
      clearInterval(heartbeat);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", reconnectNow);
      socket?.close();
    };
  }, [code, helloKey]);

  return snapshot;
}
