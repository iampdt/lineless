// What each audience sees. The public view carries numbers only: customers and the display
// screen never receive anyone's name.

import type { Pace } from "../shared/estimate";
import type { QueueView, StaffView, TicketView, YouView } from "../shared/protocol";
import { pace } from "./estimate";
import { type QueueState, RECENT_MS, type Ticket, waitingInOrder } from "./model";

export function queueView(state: QueueState, now: number): QueueView {
  const { config } = state;
  return {
    version: config.version,
    code: config.code,
    name: config.name,
    status: config.status,
    demo: config.demo,
    counters: config.counters.map((counter) => {
      const ticket = counter.serving ? state.tickets.get(counter.serving) : undefined;
      return { id: counter.id, name: counter.name, serving: ticket?.number ?? null, recalls: ticket?.recalls ?? 0 };
    }),
    waiting: waitingInOrder(state).map((t) => t.number),
    pace: roundPace(pace(config.estimator, config.counters, (id) => state.tickets.get(id)?.calledAt ?? null, now)),
    serverTime: now,
  };
}

function roundPace(p: Pace): Pace {
  return { secondsPerTicket: Math.round(p.secondsPerTicket), free: p.free, nextFreeIn: Math.round(p.nextFreeIn) };
}

export function staffView(state: QueueState, now: number): StaffView {
  const { session } = state.config;
  const called: TicketView[] = [];
  const missed: Ticket[] = [];
  for (const ticket of state.tickets.values()) {
    if (ticket.status === "called") called.push(ticketView(ticket));
    else if (ticket.status === "missed" && (ticket.finishedAt ?? 0) > now - RECENT_MS) missed.push(ticket);
  }
  missed.sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0));
  return {
    waiting: waitingInOrder(state).map(ticketView),
    called,
    missed: missed.map(ticketView),
    stats: {
      startedAt: session.startedAt,
      served: session.served,
      missed: session.missed,
      left: session.left,
      averageWaitSeconds: session.waitCount ? Math.round(session.waitTotalMs / session.waitCount / 1000) : null,
      averageServiceSeconds: session.serviceCount
        ? Math.round(session.serviceTotalMs / session.serviceCount / 1000)
        : null,
    },
    autoServe: state.config.autoServe,
  };
}

/** Positions of waiting tickets by id (1 = next), computed once per broadcast. */
export function positions(state: QueueState): Map<string, number> {
  return new Map(waitingInOrder(state).map((ticket, index) => [ticket.id, index + 1]));
}

export function youView(state: QueueState, ticket: Ticket, position: Map<string, number>): YouView {
  const counter = ticket.counterId ? state.config.counters.find((c) => c.id === ticket.counterId) : undefined;
  return {
    id: ticket.id,
    number: ticket.number,
    status: ticket.status,
    position: ticket.status === "waiting" ? (position.get(ticket.id) ?? null) : null,
    counterName: ticket.status === "called" ? (counter?.name ?? null) : null,
    recalls: ticket.recalls,
  };
}

function ticketView(ticket: Ticket): TicketView {
  return {
    id: ticket.id,
    number: ticket.number,
    name: ticket.name,
    status: ticket.status,
    counterId: ticket.counterId,
    joinedAt: ticket.joinedAt,
    calledAt: ticket.calledAt,
    recalls: ticket.recalls,
  };
}
