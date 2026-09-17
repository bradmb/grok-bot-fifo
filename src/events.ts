import type { Actor, Env, ItemRow, QueueRow } from "./types";
import { DISPATCHER_AGENT, ENG_QUEUE_KEY, OPERATOR_AGENT, PARKED_QUEUE_KEY } from "./types";
import { hmacSha256Hex, newId, nowIso } from "./http";
import { zonedWall } from "./stall";

export type FifoEventType =
  | "item.enqueued"
  | "item.assigned"
  | "item.moved"
  | "item.reordered"
  | "item.updated"
  | "item.progress"
  | "item.stalled"
  | "item.done"
  | "item.hard_blocked"
  | "item.hard_block_cleared"
  | "capacity.available"
  | "capacity.changed"
  | "eng.hours.open";

export type OutboxInsert = {
  eventId: string;
  eventType: FifoEventType;
  destination: string;
  payload: Record<string, unknown>;
  createdAt: string;
};

export function eventId(): string {
  return newId();
}

/** Hold / park / stop titles that must never wake the dispatcher's webhook (even on eng/personal). */
export function isLaneHoldNoise(title?: string | null, body?: string | null): boolean {
  const text = `${title || ""}\n${body || ""}`;
  return /\b(parked|hold|stop|do[-_ ]?not[-_ ]?touch)\b|look\s*(?:≠|!=|=)\s*go/i.test(text);
}

/**
 * FIFO wake window for team:eng and personal:* : weekdays 06:00–17:00 in the
 * business-hours timezone (same as stall.ts business window). Weekends are
 * dark all day. The timezone is configurable via STALL_TZ; the default is
 * America/Denver.
 */
export function isFifoBusinessHoursOpen(at: Date, timeZone = "America/Denver"): boolean {
  const wall = zonedWall(at, timeZone);
  const dow = new Date(Date.UTC(wall.year, wall.month - 1, wall.day)).getUTCDay();
  if (dow === 0 || dow === 6) {
    return false;
  }
  return wall.hour >= 6 && wall.hour < 17;
}

/** Alias for isFifoBusinessHoursOpen (shared Eng + personal wake window). */
export const isWithinEngHours = isFifoBusinessHoursOpen;

function dispatcherWantsEvent(
  eventType: FifoEventType,
  opts: {
    queue: QueueRow;
    item?: ItemRow | null;
    requesterRef?: string | null;
    at?: Date;
  },
): boolean {
  if (opts.queue.queue_key === PARKED_QUEUE_KEY) {
    return false;
  }
  // Queue-level open ping — not item-scoped; HOLD titles must not suppress it.
  if (eventType === "eng.hours.open") {
    return opts.queue.queue_key === ENG_QUEUE_KEY;
  }
  // After-hours quiet: claimable team:eng and personal:* events only wake the
  // dispatcher on weekdays 06:00–17:00 business-hours timezone. Audit/DB
  // writes still land; the eng.hours.open ping above stays exempt so the
  // Monday-morning drain still fires.
  const claimable =
    eventType === "item.enqueued" ||
    eventType === "item.assigned" ||
    eventType === "item.stalled" ||
    eventType === "item.hard_blocked" ||
    eventType === "item.hard_block_cleared";
  if (
    claimable &&
    (opts.queue.queue_key === ENG_QUEUE_KEY || opts.queue.kind === "personal") &&
    !isFifoBusinessHoursOpen(opts.at ?? new Date())
  ) {
    return false;
  }
  if (isLaneHoldNoise(opts.item?.title, opts.item?.body)) {
    return false;
  }
  // Never wake the dispatcher on move / reorder / capacity chatter / progress / update / cancel.
  if (
    eventType === "item.moved" ||
    eventType === "item.reordered" ||
    eventType === "capacity.changed" ||
    eventType === "capacity.available" ||
    eventType === "item.updated" ||
    eventType === "item.progress"
  ) {
    return false;
  }
  // Cheap terminal-replay guard: non-terminal event types skip if item already terminal.
  const state = opts.item?.state;
  if (
    state &&
    (state === "done" || state === "cancelled") &&
    (eventType === "item.enqueued" ||
      eventType === "item.assigned" ||
      eventType === "item.stalled" ||
      eventType === "item.hard_blocked" ||
      eventType === "item.hard_block_cleared")
  ) {
    return false;
  }
  if (eventType === "item.enqueued" || eventType === "item.assigned") {
    return opts.queue.queue_key === ENG_QUEUE_KEY;
  }
  if (eventType === "item.stalled") {
    return true;
  }
  if (eventType === "item.hard_blocked" || eventType === "item.hard_block_cleared") {
    return opts.queue.queue_key === ENG_QUEUE_KEY;
  }
  if (eventType === "item.done") {
    const ref = (opts.requesterRef ?? opts.item?.requester_ref ?? "").trim();
    return Boolean(ref) && ref !== OPERATOR_AGENT;
  }
  return false;
}

export function destinationsFor(
  eventType: FifoEventType,
  opts: {
    queue: QueueRow;
    item?: ItemRow | null;
    ownerKey?: string | null;
    requesterRef?: string | null;
    at?: Date;
  },
): string[] {
  const dest = new Set<string>();
  if (dispatcherWantsEvent(eventType, opts)) {
    dest.add(DISPATCHER_AGENT);
  }
  const personalOwnerWake =
    opts.queue.kind === "personal" &&
    Boolean(opts.ownerKey) &&
    isFifoBusinessHoursOpen(opts.at ?? new Date()) &&
    (eventType === "item.enqueued" || eventType === "item.assigned" || eventType === "item.stalled");
  if (personalOwnerWake && opts.ownerKey) {
    dest.add(opts.ownerKey);
  }
  if (eventType === "item.done" && opts.requesterRef) {
    dest.add(opts.requesterRef);
  }
  dest.delete(OPERATOR_AGENT);
  // Empty is OK — audit still lands; do not fall back to the dispatcher (noop wake).
  return [...dest];
}

export function cloudEvent(input: {
  eventId: string;
  eventType: FifoEventType;
  time: string;
  data: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    specversion: "1.0",
    id: input.eventId,
    source: "fifo-worker",
    type: input.eventType,
    time: input.time,
    datacontenttype: "application/json",
    data: input.data,
  };
}

export async function signEnvelope(
  secret: string,
  eventIdValue: string,
  timestamp: string,
  body: string,
): Promise<string> {
  return hmacSha256Hex(secret, `${timestamp}.${eventIdValue}.${body}`);
}

export function outboxStatements(
  env: Env,
  inserts: OutboxInsert[],
): ReturnType<Env["DB"]["prepare"]>[] {
  return inserts.map((row) =>
    env.DB.prepare(
      `INSERT INTO webhook_outbox (
        id, event_id, event_type, payload_json, destination, status,
        attempts, next_attempt_at, last_error, created_at, delivered_at
      ) VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, NULL, ?, NULL)`,
    ).bind(row.eventId, row.eventId, row.eventType, JSON.stringify(row.payload), row.destination, row.createdAt, row.createdAt),
  );
}

export function auditStatement(
  env: Env,
  input: {
    id: string;
    itemId?: string | null;
    queueId?: string | null;
    eventType: string;
    actor: Actor | null;
    payload: Record<string, unknown>;
    createdAt: string;
  },
): ReturnType<Env["DB"]["prepare"]> {
  return env.DB.prepare(
    `INSERT INTO item_events (id, item_id, queue_id, event_type, actor_agent_id, payload_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    input.id,
    input.itemId ?? null,
    input.queueId ?? null,
    input.eventType,
    input.actor?.agentId ?? null,
    JSON.stringify(input.payload),
    input.createdAt,
  );
}

export async function deliverOutbox(env: Env, limit = 20, now = nowIso()): Promise<number> {
  const pending = await env.DB.prepare(
    `SELECT * FROM webhook_outbox
     WHERE status IN ('pending', 'failed') AND next_attempt_at <= ?
     ORDER BY created_at ASC LIMIT ?`,
  )
    .bind(now, limit)
    .all<{
      id: string;
      event_id: string;
      event_type: FifoEventType;
      payload_json: string;
      destination: string;
      attempts: number;
    }>();

  let delivered = 0;
  for (const row of pending.results || []) {
    const url = row.destination === DISPATCHER_AGENT ? env.WEBHOOK_DISPATCH_URL || "" : "";
    const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
    const envelope = cloudEvent({
      eventId: row.event_id,
      eventType: row.event_type,
      time: now,
      data: payload,
    });
    const body = JSON.stringify(envelope);
    const timestamp = now;
    const secret = env.WEBHOOK_HMAC_SECRET || "";
    const signature = secret ? await signEnvelope(secret, row.event_id, timestamp, body) : "";

    if (!url) {
      await env.DB.prepare(
        `UPDATE webhook_outbox SET status = 'stubbed', attempts = attempts + 1, delivered_at = ? WHERE id = ?`,
      )
        .bind(now, row.id)
        .run();
      delivered += 1;
      continue;
    }

    try {
      // Receivers expect application/json (415 on cloudevents+json).
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "Fifo-Event-Id": row.event_id,
        "Fifo-Timestamp": timestamp,
      };
      if (signature) {
        headers["Fifo-Signature"] = `sha256=${signature}`;
      }
      const dispatchAuth = (env.WEBHOOK_DISPATCH_AUTHORIZATION || "").trim();
      if (dispatchAuth) {
        headers.Authorization = dispatchAuth;
      }
      const res = await fetch(url, {
        method: "POST",
        headers,
        body,
      });
      if (res.ok) {
        await env.DB.prepare(
          `UPDATE webhook_outbox SET status = 'delivered', attempts = attempts + 1, delivered_at = ?, last_error = NULL WHERE id = ?`,
        )
          .bind(now, row.id)
          .run();
        delivered += 1;
      } else {
        await bumpOutboxFailure(env, row.id, row.attempts, `http_${res.status}`, now);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "fetch_failed";
      await bumpOutboxFailure(env, row.id, row.attempts, message, now);
    }
  }
  return delivered;
}

async function bumpOutboxFailure(env: Env, id: string, attempts: number, error: string, now: string): Promise<void> {
  const nextAttempts = attempts + 1;
  const delayMin = Math.min(30, 2 ** Math.min(nextAttempts, 5));
  const nextAt = new Date(new Date(now).getTime() + delayMin * 60_000).toISOString();
  const status = nextAttempts >= 10 ? "failed" : "pending";
  await env.DB.prepare(
    `UPDATE webhook_outbox SET status = ?, attempts = ?, next_attempt_at = ?, last_error = ? WHERE id = ?`,
  )
    .bind(status, nextAttempts, nextAt, error.slice(0, 200), id)
    .run();
}
