import { SCHEMA_SQL, SEED_SQL } from "./schema";
import type { D1Database, Env, QueueRow, ItemRow, SlotRow, AgentRow, CommentRow } from "./types";

const schemaReady = new WeakSet<object>();

export async function ensureSchema(db: D1Database): Promise<void> {
  if (schemaReady.has(db)) {
    return;
  }
  // Production uses wrangler D1 migrations. Skip re-exec of schema.sql comments
  // (D1 db.exec rejects bare "-- ..." lines with SQLITE incomplete input).
  const existing = await db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'agents'")
    .first<{ name: string }>();
  if (!existing) {
    await execStatements(db, SCHEMA_SQL);
    await execStatements(db, SEED_SQL);
  }
  schemaReady.add(db);
}

async function execStatements(db: D1Database, sql: string): Promise<void> {
  const parts = sql
    .split(";")
    .map((s) =>
      s
        .split(/\r?\n/)
        .map((line) => line.replace(/--.*$/, "").trimEnd())
        .join("\n")
        .trim(),
    )
    .filter((s) => s.length > 0);
  for (const stmt of parts) {
    await db.exec(stmt);
  }
}


export function resetSchemaFlag(): void {
  /* WeakSet is per-database; kept for tests that rebuild Env.DB */
}

export async function getQueue(env: Env, queueKey: string): Promise<QueueRow | null> {
  return env.DB.prepare("SELECT * FROM queues WHERE queue_key = ?").bind(queueKey).first<QueueRow>();
}

export async function getAgent(env: Env, idOrKey: string): Promise<AgentRow | null> {
  return env.DB.prepare("SELECT * FROM agents WHERE id = ? OR key = ?").bind(idOrKey, idOrKey).first<AgentRow>();
}

export async function getItem(env: Env, id: string): Promise<ItemRow | null> {
  return env.DB.prepare("SELECT * FROM items WHERE id = ?").bind(id).first<ItemRow>();
}

export async function getSlotForAgent(env: Env, queueId: string, agentId: string): Promise<SlotRow | null> {
  return env.DB.prepare("SELECT * FROM queue_slots WHERE queue_id = ? AND agent_id = ?")
    .bind(queueId, agentId)
    .first<SlotRow>();
}

export async function listSlots(env: Env, queueId: string): Promise<SlotRow[]> {
  const result = await env.DB.prepare("SELECT * FROM queue_slots WHERE queue_id = ? ORDER BY label")
    .bind(queueId)
    .all<SlotRow>();
  return result.results || [];
}

export async function listItemsByState(env: Env, queueId: string, states: string[]): Promise<ItemRow[]> {
  const placeholders = states.map(() => "?").join(", ");
  const result = await env.DB.prepare(
    `SELECT * FROM items WHERE queue_id = ? AND state IN (${placeholders}) ORDER BY fifo_seq ASC`,
  )
    .bind(queueId, ...states)
    .all<ItemRow>();
  return result.results || [];
}

export async function countWip(env: Env, queueId: string): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM items WHERE queue_id = ? AND state = 'in_progress'",
  )
    .bind(queueId)
    .first<{ n: number }>();
  return Number(row?.n || 0);
}

export async function nextFifoSeq(env: Env, queueId: string): Promise<number> {
  const row = await env.DB.prepare("SELECT COALESCE(MAX(fifo_seq), 0) + 1 AS n FROM items WHERE queue_id = ?")
    .bind(queueId)
    .first<{ n: number }>();
  return Number(row?.n || 1);
}

export async function oldestQueued(env: Env, queueId: string): Promise<ItemRow | null> {
  return env.DB.prepare(
    "SELECT * FROM items WHERE queue_id = ? AND state = 'queued' ORDER BY fifo_seq ASC LIMIT 1",
  )
    .bind(queueId)
    .first<ItemRow>();
}

export async function countCodeReview(env: Env, queueId: string): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM items WHERE queue_id = ? AND state = 'code_review'",
  )
    .bind(queueId)
    .first<{ n: number }>();
  return Number(row?.n || 0);
}

export async function crHeldBy(env: Env, queueId: string, agentId: string): Promise<ItemRow | null> {
  return env.DB.prepare(
    "SELECT * FROM items WHERE queue_id = ? AND assignee_agent_id = ? AND state = 'code_review'",
  )
    .bind(queueId, agentId)
    .first<ItemRow>();
}

export async function findBySource(env: Env, sourceSystem: string, sourceRef: string): Promise<ItemRow | null> {
  if (!sourceRef) {
    return null;
  }
  return env.DB.prepare("SELECT * FROM items WHERE source_system = ? AND source_ref = ?")
    .bind(sourceSystem, sourceRef)
    .first<ItemRow>();
}

export async function publicComments(env: Env, itemId: string): Promise<CommentRow[]> {
  const result = await env.DB.prepare(
    "SELECT * FROM comments WHERE item_id = ? AND public = 1 ORDER BY created_at ASC",
  )
    .bind(itemId)
    .all<CommentRow>();
  return result.results || [];
}

export async function agentNameMap(env: Env): Promise<Map<string, string>> {
  const result = await env.DB.prepare("SELECT id, display_name FROM agents").all<AgentRow>();
  const map = new Map<string, string>();
  for (const row of result.results || []) {
    map.set(row.id, row.display_name);
  }
  return map;
}

export function isUniqueError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /UNIQUE constraint failed/i.test(message);
}
