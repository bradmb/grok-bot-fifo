import { DatabaseSync } from "node:sqlite";
import { SCHEMA_SQL, SEED_SQL } from "../src/schema.ts";
import { resetSchemaFlag } from "../src/db.ts";
import { sha256Hex } from "../src/http.ts";
import type { D1Database, D1PreparedStatement, D1Result, Env } from "../src/types.ts";

class SqliteStatement implements D1PreparedStatement {
  constructor(
    private readonly db: DatabaseSync,
    private readonly sql: string,
    private readonly params: unknown[] = [],
  ) {}

  bind(...values: unknown[]): D1PreparedStatement {
    return new SqliteStatement(this.db, this.sql, values);
  }

  async first<T = unknown>(): Promise<T | null> {
    const params = this.params as never[];
    const stmt = this.db.prepare(this.sql);
    const row = stmt.get(...params) as T | undefined;
    return row ?? null;
  }

  async all<T = unknown>(): Promise<D1Result<T>> {
    const params = this.params as never[];
    const stmt = this.db.prepare(this.sql);
    const results = stmt.all(...params) as T[];
    return { results, success: true };
  }

  async run(): Promise<D1Result<unknown>> {
    const params = this.params as never[];
    const stmt = this.db.prepare(this.sql);
    const info = stmt.run(...params) as { changes?: number | bigint };
    return { success: true, meta: { changes: Number(info?.changes ?? 0) } };
  }
}

export function sqliteD1(): D1Database & { raw: DatabaseSync } {
  const raw = new DatabaseSync(":memory:");
  raw.exec("PRAGMA foreign_keys = ON");
  raw.exec(SCHEMA_SQL);
  raw.exec(SEED_SQL);
  const db: D1Database & { raw: DatabaseSync } = {
    raw,
    prepare(query: string) {
      return new SqliteStatement(raw, query);
    },
    async batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
      raw.exec("BEGIN");
      try {
        const out: D1Result<T>[] = [];
        for (const statement of statements) {
          out.push((await statement.run()) as D1Result<T>);
        }
        raw.exec("COMMIT");
        return out;
      } catch (error) {
        raw.exec("ROLLBACK");
        throw error;
      }
    },
    async exec(query: string) {
      raw.exec(query);
    },
  };
  return db;
}

export async function testEnv(overrides: Partial<Env> = {}): Promise<Env> {
  resetSchemaFlag();
  const DB = overrides.DB || sqliteD1();
  const env: Env = {
    DB,
    AUTH_REQUIRED: "false",
    CF_ACCESS_TEAM_DOMAIN: "https://example.cloudflareaccess.com",
    CF_ACCESS_AUD: "fifo-aud",
    FIFO_API_HOST: "api.fifo.example",
    FIFO_SHARE_HOST: "share.fifo.example",
    SHARE_PUBLIC_ORIGIN: "https://share.fifo.example",
    STALL_TZ: "America/Denver",
    STALL_START_HOUR: "8",
    STALL_END_HOUR: "17",
    STALL_BUSINESS_MINUTES: "60",
    ENG_CAPACITY: "6",
    WEBHOOK_HMAC_SECRET: "test-webhook-hmac",
    WEBHOOK_DISPATCH_URL: "",
    ...overrides,
  };
  await seedTestClients(env);
  return env;
}

export async function seedTestClients(env: Env): Promise<void> {
  const dispatcherHash = await sha256Hex("test-dispatcher-secret");
  const dev1Hash = await sha256Hex("test-dev1-secret");
  const now = "2026-09-10T00:00:00.000Z";
  await env.DB.exec(`
    INSERT OR REPLACE INTO api_clients (id, client_id, secret_hash, agent_id, permissions_json, name, created_at) VALUES
      ('client-dispatcher', 'dev-dispatcher', '${dispatcherHash}', 'dispatcher', '["dispatcher"]', 'dispatcher client', '${now}'),
      ('client-dev1', 'dev-dev1', '${dev1Hash}', 'dev1', '["personal:own","team:eng:enqueue","team:parked:enqueue"]', 'dev1 client', '${now}'),
      ('client-runner', 'dev-runner', '', 'runner', '["runner","team:eng:progress"]', 'runner client', '${now}'),
      ('client-ic1', 'dev-ic1', '', 'ic1', '["personal:own","team:eng:enqueue","team:eng:progress"]', 'ic1 client', '${now}');
  `);
}

export const LOCAL = "http://127.0.0.1:8787";

export function dispatcherHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    "CF-Access-Client-Id": "dev-dispatcher",
    "X-Fifo-Actor": "dispatcher",
    "Content-Type": "application/json",
    ...extra,
  };
}

export function dev1Headers(extra: Record<string, string> = {}): Record<string, string> {
  return {
    "CF-Access-Client-Id": "dev-dev1",
    "X-Fifo-Actor": "dev1",
    "Content-Type": "application/json",
    ...extra,
  };
}

export function runnerHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    "CF-Access-Client-Id": "dev-runner",
    "X-Fifo-Actor": "runner",
    "Content-Type": "application/json",
    ...extra,
  };
}

export function ic1Headers(extra: Record<string, string> = {}): Record<string, string> {
  return {
    "CF-Access-Client-Id": "dev-ic1",
    "X-Fifo-Actor": "ic1",
    "Content-Type": "application/json",
    ...extra,
  };
}

export function idem(key: string): Record<string, string> {
  return { "Idempotency-Key": key };
}
