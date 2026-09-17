import { getQueue, isUniqueError } from "./db";
import { auditStatement, deliverOutbox, destinationsFor, eventId, outboxStatements } from "./events";
import { newId } from "./http";
import { nextStallAt, stallConfigFromEnv, zonedWall } from "./stall";
import type { Env, ItemRow, QueueRow } from "./types";
import { ENG_QUEUE_KEY } from "./types";

export const ENG_HOURS_TZ = "America/Denver";
export const ENG_OPEN_HOUR = 6;
export const ENG_OPEN_MINUTE_MAX = 4;

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

export function hoursDateKey(at: Date, timeZone = ENG_HOURS_TZ): string {
  const wall = zonedWall(at, timeZone);
  return `${wall.year}-${pad2(wall.month)}-${pad2(wall.day)}`;
}

export function engHoursOpenMarkerId(dateKey: string): string {
  return `eng.hours.open:${dateKey}`;
}

/** Weekday 06:00–06:04 in the business-hours timezone (covers the every-5-min tick plus a few minutes of slop). */
export function isEngHoursOpenTick(at: Date, timeZone = ENG_HOURS_TZ): boolean {
  const wall = zonedWall(at, timeZone);
  const dow = new Date(Date.UTC(wall.year, wall.month - 1, wall.day)).getUTCDay();
  if (dow === 0 || dow === 6) {
    return false;
  }
  return wall.hour === ENG_OPEN_HOUR && wall.minute <= ENG_OPEN_MINUTE_MAX;
}

export async function runScheduled(
  env: Env,
  at = new Date(),
): Promise<{ stalls: number; outbox: number; engOpen: number }> {
  const stalls = await sweepStalls(env, at.toISOString());
  const engOpen = await maybeEmitEngHoursOpen(env, at);
  const outbox = await deliverOutbox(env, 25, at.toISOString());
  return { stalls, outbox, engOpen };
}

export async function maybeEmitEngHoursOpen(env: Env, at: Date): Promise<number> {
  if (!isEngHoursOpenTick(at)) {
    return 0;
  }
  const dateKey = hoursDateKey(at);
  const markerId = engHoursOpenMarkerId(dateKey);
  const existing = await env.DB.prepare("SELECT id FROM item_events WHERE id = ?").bind(markerId).first();
  if (existing) {
    return 0;
  }
  const queue = await getQueue(env, ENG_QUEUE_KEY);
  if (!queue) {
    return 0;
  }
  const openedAt = at.toISOString();
  const dests = destinationsFor("eng.hours.open", { queue });
  const payload = {
    timezone: ENG_HOURS_TZ,
    opened_at: openedAt,
    queue_key: ENG_QUEUE_KEY,
    hours_date: dateKey,
    hours: { start: "06:00", end: "17:00" },
    hint: "claim-next claimable queued heads when free seats exist",
  };
  const inserts = dests.map((destination) => ({
    eventId: eventId(),
    eventType: "eng.hours.open" as const,
    destination,
    payload,
    createdAt: openedAt,
  }));
  try {
    await env.DB.batch([
      auditStatement(env, {
        id: markerId,
        itemId: null,
        queueId: queue.id,
        eventType: "eng.hours.open",
        actor: null,
        payload,
        createdAt: openedAt,
      }),
      ...outboxStatements(env, inserts),
    ]);
    return 1;
  } catch (error) {
    if (isUniqueError(error)) {
      return 0;
    }
    throw error;
  }
}

/** Factory In Progress stall sweep only. CR does not use the Factory stall clock. */
export async function sweepStalls(env: Env, now: string): Promise<number> {
  const due = await env.DB.prepare(
    `SELECT * FROM items
     WHERE state = 'in_progress' AND next_stall_at IS NOT NULL AND next_stall_at <= ?
     ORDER BY next_stall_at ASC`,
  )
    .bind(now)
    .all<ItemRow>();

  let count = 0;
  const cfg = stallConfigFromEnv(env);
  for (const item of due.results || []) {
    const generation = item.stall_generation;
    const nextAt = nextStallAt(now, cfg);
    const result = await env.DB.prepare(
      `UPDATE items SET stall_generation = stall_generation + 1, next_stall_at = ?, updated_at = ?
       WHERE id = ? AND state = 'in_progress' AND stall_generation = ?`,
    )
      .bind(nextAt, now, item.id, generation)
      .run();
    if (!result.meta?.changes) {
      continue;
    }
    const queue = await env.DB.prepare("SELECT * FROM queues WHERE id = ?").bind(item.queue_id).first<QueueRow>();
    if (!queue) {
      continue;
    }
    const owner = queue.owner_agent_id;
    const dests = destinationsFor("item.stalled", { queue, item, ownerKey: owner, at: new Date(now) });
    const payload = {
      queue_key: queue.queue_key,
      item_id: item.id,
      title: item.title,
      stall_generation: generation,
    };
    const inserts = dests.map((destination) => ({
      eventId: eventId(),
      eventType: "item.stalled" as const,
      destination,
      payload,
      createdAt: now,
    }));
    await env.DB.batch([
      auditStatement(env, {
        id: newId(),
        itemId: item.id,
        queueId: queue.id,
        eventType: "item.stalled",
        actor: null,
        payload,
        createdAt: now,
      }),
      ...outboxStatements(env, inserts),
    ]);
    count += 1;
  }
  return count;
}
