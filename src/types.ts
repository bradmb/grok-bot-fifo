export type ItemState = "queued" | "in_progress" | "code_review" | "done" | "cancelled";
export type WorkKind = "code_review" | "implement" | "ops";
export type QueueKind = "personal" | "team";
export type SlotStatus = "enabled" | "draining" | "disabled";
export type OutboxStatus = "pending" | "delivered" | "stubbed" | "failed";
export type Permission =
  | "dispatcher"
  | "runner"
  | "personal:own"
  | "team:eng:enqueue"
  | "team:eng:progress"
  | "team:parked:enqueue";

export interface D1Meta {
  changes?: number;
}

export interface D1Result<T> {
  results?: T[];
  meta?: D1Meta;
  success?: boolean;
  error?: string;
}

export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = unknown>(): Promise<T | null>;
  all<T = unknown>(): Promise<D1Result<T>>;
  run(): Promise<D1Result<unknown>>;
}

export interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
  exec(query: string): Promise<unknown>;
}

export interface WorkerExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

export interface ScheduledEvent {
  scheduledTime: number;
  cron: string;
}

export interface Env {
  DB: D1Database;
  AUTH_REQUIRED: string;
  CF_ACCESS_TEAM_DOMAIN: string;
  CF_ACCESS_AUD?: string;
  FIFO_API_HOST: string;
  FIFO_SHARE_HOST: string;
  SHARE_PUBLIC_ORIGIN: string;
  STALL_TZ: string;
  STALL_START_HOUR: string;
  STALL_END_HOUR: string;
  STALL_BUSINESS_MINUTES: string;
  ENG_CAPACITY: string;
  WEBHOOK_HMAC_SECRET?: string;
  WEBHOOK_DISPATCH_URL?: string;
  /** Full Authorization header value, e.g. "Bearer …" for the dispatcher webhook. */
  WEBHOOK_DISPATCH_AUTHORIZATION?: string;
}

export interface AgentRow {
  id: string;
  key: string;
  display_name: string;
  quiet: number;
  created_at: string;
}

export interface QueueRow {
  id: string;
  queue_key: string;
  kind: QueueKind;
  owner_agent_id: string | null;
  title: string;
  capacity: number;
  share_generation: number;
  created_at: string;
}

export interface SlotRow {
  id: string;
  queue_id: string;
  agent_id: string;
  label: string;
  status: SlotStatus;
  created_at: string;
}

export interface ItemRow {
  id: string;
  queue_id: string;
  fifo_seq: number;
  state: ItemState;
  slot_id: string | null;
  assignee_agent_id: string | null;
  source_system: string;
  source_ref: string;
  requester_ref: string;
  title: string;
  body: string;
  team_scope: string | null;
  kind: WorkKind;
  cr_slot: string | null;
  ca_ref: string | null;
  factory_ref: string | null;
  enqueued_at: string;
  started_at: string | null;
  done_at: string | null;
  progress_at: string | null;
  next_stall_at: string | null;
  stall_generation: number;
  hard_blocked_at: string | null;
  block_reason: string | null;
  created_at: string;
  updated_at: string;
}

export interface CommentRow {
  id: string;
  item_id: string;
  author_agent_id: string | null;
  body: string;
  kind: "note" | "progress";
  public: number;
  created_at: string;
}

export interface ShareTokenRow {
  id: string;
  queue_id: string;
  token_hash: string;
  token_prefix: string;
  generation: number;
  focus_item_id: string | null;
  revoked_at: string | null;
  created_at: string;
}

export interface ApiClientRow {
  id: string;
  client_id: string;
  secret_hash: string;
  agent_id: string | null;
  permissions_json: string;
  name: string;
  created_at: string;
}

export interface IdempotencyRow {
  idempotency_key: string;
  client_id: string;
  method: string;
  path: string;
  request_hash: string;
  status: number;
  response_json: string;
  created_at: string;
}

export interface OutboxRow {
  id: string;
  event_id: string;
  event_type: string;
  payload_json: string;
  destination: string;
  status: OutboxStatus;
  attempts: number;
  next_attempt_at: string;
  last_error: string | null;
  created_at: string;
  delivered_at: string | null;
}

export interface Actor {
  clientId: string;
  agentId: string | null;
  agentKey: string | null;
  permissions: Permission[];
  name: string;
}

export interface AccessJwtPayload {
  email?: string;
  preferred_username?: string;
  common_name?: string;
  sub?: string;
  name?: string;
  aud?: string | string[];
  iss?: string;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: Record<string, unknown>;

  constructor(status: number, code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const ENG_QUEUE_KEY = "team:eng";
export const PARKED_QUEUE_KEY = "team:parked";
export const DISPATCHER_PERSONAL_QUEUE_KEY = "personal:dispatcher";
export const ENG_ICS = ["ic1", "ic2", "ic3", "ic4", "ic5", "ic6"] as const;
export const DISPATCHER_AGENT = "dispatcher";
export const OPERATOR_AGENT = "operator";
export const PLATE_FULL_PREFIX = "Plate full — here's my queue: ";

export function isMovableTeamQueue(queueKey: string): boolean {
  return queueKey === ENG_QUEUE_KEY || queueKey === PARKED_QUEUE_KEY;
}
