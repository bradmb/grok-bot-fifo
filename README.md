# grok-bot-fifo

A shared **FIFO work queue for Grok Bot agent fleets**.

This repo is a Cloudflare Worker plus D1 database (the queue authority) and a
headless `fifo` CLI. Agents enqueue work, claim seats, stall-chase, and mark
items done. The Worker never chats: it POSTs signed CloudEvents to a **Grok Bot
webhook routine** when work is enqueued, assigned, stalled, or completed.

- **Repo:** https://github.com/bradmb/grok-bot-fifo
- **License:** MIT
- **Secrets:** never commit tokens, Access credentials, or webhook `Authorization` values

## What you get

- **Personal queues** (`personal:<agent>`) — one in-progress seat per owner (WIP = 1). Overflow stays queued and the response includes a share link.
- **Eng team FIFO** (`team:eng`) — N named IC seats (`queue_slots`). `claim-next` fills Factory seats; `claim-cr` fills a parallel Code Review lane that does not consume Factory capacity.
- **Parked hold lane** (`team:parked`) — capacity 0, not claimable. Items move between eng and parked.
- **Hard-block** — holds a seat; `clear-block` unblocks without releasing it.
- **Stall clock** — Factory in-progress items stall after a configurable run of business minutes (default America/Denver, 08:00–17:00, 60 minutes).
- **Share boards** — `GET /s/<token>` renders Queued | In Progress | Code Review. No secrets, live refresh. The token is the bearer.
- **Webhook outbox** — CloudEvents 1.0, HMAC-signed, delivered immediately with cron retry.

## Prerequisites

- Node.js 22+ and npm
- A Cloudflare account with Workers and D1
- A Grok Bot agent that will own queue operations (the **dispatcher**)
- Recommended in production: Cloudflare Zero Trust Access with a service token on the API host

## Install and deploy

### 1. Clone and install

```bash
git clone https://github.com/bradmb/grok-bot-fifo.git
cd grok-bot-fifo
npm ci
npm test
npm run typecheck
```

### 2. Log in to Cloudflare

```bash
npx wrangler login
npx wrangler whoami
```

`whoami` prints the Cloudflare `account_id` you will put in `wrangler.toml`.

### 3. Create D1 and wire `wrangler.toml`

```bash
npx wrangler d1 create fifo-worker
```

Copy the returned `database_id` into `wrangler.toml`. Do not invent an id.

```toml
[[d1_databases]]
binding = "DB"
database_name = "fifo-worker"
database_id = "<from-wrangler-d1-create>"
migrations_dir = "migrations"
```

Set `account_id` from `wrangler whoami` (uncomment the line in `wrangler.toml`).

Under `[vars]`, replace the placeholder hostnames (`CF_ACCESS_TEAM_DOMAIN`,
`FIFO_API_HOST`, `FIFO_SHARE_HOST`, `SHARE_PUBLIC_ORIGIN`) with your domain.
For a first deploy you can leave the placeholders and keep `workers_dev = true`
so the Worker is reachable on `*.workers.dev`. On that host the Worker serves
both `/v1/*` and `/s/*`, and share links use the request origin.

### 4. Apply migrations

Local D1 (for `wrangler dev`):

```bash
npx wrangler d1 migrations apply fifo-worker --local
```

Production D1:

```bash
npx wrangler d1 migrations apply fifo-worker --remote
```

### 5. Deploy the Worker

```bash
npx wrangler deploy
```

Note the Worker URL (for example `https://fifo-worker.<account>.workers.dev`).
That base URL is `FIFO_API` for the CLI and for agents.

### 6. Custom hosts and Cloudflare Access

For a production split between an authenticated API and a public share board:

1. Create DNS for `fifo-api.<your-domain>` and `fifo-share.<your-domain>`.
2. Set `[vars]` to match:
   - `FIFO_API_HOST` — hostname that serves `/v1/*` only
   - `FIFO_SHARE_HOST` — hostname that serves `/s/*` only
   - `SHARE_PUBLIC_ORIGIN` — public origin used when minting share links (`https://fifo-share.<your-domain>`)
   - `CF_ACCESS_TEAM_DOMAIN` — `https://<your-team>.cloudflareaccess.com`
3. Uncomment `routes` in `wrangler.toml`. Once Access is live on the API host, set `workers_dev = false` so the API is not also exposed on `*.workers.dev`.
4. Create a Cloudflare Zero Trust **Access** application on the API host with a **service-token** policy for machines and agents.
5. Leave the share host **without** Access. `/s/<token>` is its own bearer.
6. Put the Access application audience in the `CF_ACCESS_AUD` secret.

The Worker enforces the split: share routes 404 on the API host, and API routes 404 on the share host.

### 7. Secrets (never commit)

```bash
npx wrangler secret put WEBHOOK_HMAC_SECRET
npx wrangler secret put WEBHOOK_DISPATCH_URL
npx wrangler secret put WEBHOOK_DISPATCH_AUTHORIZATION
npx wrangler secret put CF_ACCESS_AUD
```

| Secret | Purpose |
|---|---|
| `WEBHOOK_HMAC_SECRET` | HMAC-SHA256 key for signed CloudEvent bodies (`Fifo-Signature`) |
| `WEBHOOK_DISPATCH_URL` | Grok Bot routine webhook URL. Empty or unset = stub delivery (rows stay in D1 as `stubbed`; nothing is POSTed) |
| `WEBHOOK_DISPATCH_AUTHORIZATION` | Full `Authorization` header value sent to that URL (usually `Bearer …`, exactly as Grok Bot shows it) |
| `CF_ACCESS_AUD` | Access application audience for JWT verification on the API host |

Fallback bearer hashes live in D1 (`api_clients.secret_hash`), not in Wrangler secrets. See the next step.

### 8. Seed `api_clients`

Callers authenticate with one of:

- Cloudflare Access JWT (`Cf-Access-Jwt-Assertion`, added by Access in front of the API host)
- Access service token headers (`CF-Access-Client-Id` / `CF-Access-Client-Secret`)
- `Authorization: Bearer <token>` whose SHA-256 matches `secret_hash`

Only the **hash** is stored. Hash the client secret (or bearer token) locally — never paste the raw value into git or chat:

```bash
printf '%s' "$CLIENT_SECRET" | openssl dgst -sha256 | awk '{print $NF}'
```

The printed hex digest is `secret_hash`. For an Access service token, `client_id` is the token’s Client ID and `secret_hash` is the SHA-256 of its Client Secret.

```sql
INSERT INTO api_clients (id, client_id, secret_hash, agent_id, permissions_json, name, created_at)
VALUES (
  lower(hex(randomblob(16))),
  '<access-client-id-or-bearer-client-key>',
  '<sha256-hex of the secret>',
  'dispatcher',
  '["dispatcher"]',
  'Dispatcher Grok Bot',
  datetime('now')
);
```

```bash
npx wrangler d1 execute fifo-worker --remote --command "<sql>"
```

Permissions:

| Permission | Grants |
|---|---|
| `dispatcher` | Full queue ops: claim, cancel, move, sync, team share, act as another agent via `X-Fifo-Actor` |
| `runner` | Move eng ↔ parked; progress / done / block on any item |
| `team:eng:enqueue` | Enqueue on `team:eng` (and `team:parked`) |
| `team:parked:enqueue` | Enqueue on `team:parked` |
| `team:eng:progress` | Progress / done / block on items |
| `personal:own` | Label for personal-queue clients. A client bound to an agent can already enqueue, mutate, and mint shares on its own `personal:<agent>` queue |

Seed ICs and seats with migrations; set `ENG_CAPACITY` in `wrangler.toml` to match (default `6`).

### 9. Smoke test

```bash
export FIFO_API=https://fifo-worker.<account>.workers.dev   # or https://fifo-api.<your-domain>
curl -s "$FIFO_API/health"
# {"ok":true,"service":"fifo-worker"}
```

`GET /health` is public. Queue APIs need credentials (values from your vault — do not paste secrets into chat):

```bash
curl -s "$FIFO_API/v1/queues/team:eng" \
  -H "CF-Access-Client-Id: $FIFO_ACCESS_CLIENT_ID" \
  -H "CF-Access-Client-Secret: $FIFO_ACCESS_CLIENT_SECRET" \
  -H "X-Fifo-Actor: dispatcher"
```

## Hook Grok Bot agent routines

The Worker POSTs signed CloudEvents to a URL you own. Point that URL at a
**webhook routine** on the Grok Bot agent that runs FIFO ops (the dispatcher).

### Map the routine to Worker secrets

1. Open the dispatcher agent in Grok Bot and add a **webhook** routine.
2. Copy from the routine sidebar:
   - **Webhook URL** → `WEBHOOK_DISPATCH_URL`
   - **Webhook key / Authorization header** → `WEBHOOK_DISPATCH_AUTHORIZATION` (the exact header value, usually `Bearer <key>`)
3. Put the same HMAC key on both sides as `WEBHOOK_HMAC_SECRET`.

```bash
npx wrangler secret put WEBHOOK_DISPATCH_URL
# paste the Grok Bot routine webhook URL

npx wrangler secret put WEBHOOK_DISPATCH_AUTHORIZATION
# paste: Bearer …   (exact value from Grok Bot)

npx wrangler secret put WEBHOOK_HMAC_SECRET
# paste a long random string; store the same value on the routine for verification
```

### CloudEvents envelope

Each POST is `Content-Type: application/json` (not `application/cloudevents+json`) with a CloudEvents 1.0 body:

```json
{
  "specversion": "1.0",
  "id": "5d1c0b7e-8f3a-4e0d-9a51-1f9d2c4a6b21",
  "source": "fifo-worker",
  "type": "item.enqueued",
  "time": "2026-09-17T14:05:00.000Z",
  "datacontenttype": "application/json",
  "data": {
    "queue_key": "team:eng",
    "item_id": "…",
    "title": "Fix login redirect"
  }
}
```

Dedupe on `id`. Retries reuse the same `id` and re-sign with a new timestamp.

### HMAC verification

Headers on every signed POST:

| Header | Value |
|---|---|
| `Fifo-Event-Id` | CloudEvent `id` |
| `Fifo-Timestamp` | ISO-8601 time of this delivery attempt |
| `Fifo-Signature` | `sha256=<hex>` HMAC-SHA256 of `{timestamp}.{eventId}.{rawBody}` using `WEBHOOK_HMAC_SECRET` |
| `Authorization` | `WEBHOOK_DISPATCH_AUTHORIZATION`, if set |

Reject a mismatched signature before the routine mutates any queue state.

```js
import { createHmac, timingSafeEqual } from "node:crypto";

function verifyFifoSignature(headers, rawBody, secret) {
  const eventId = headers["fifo-event-id"] ?? "";
  const timestamp = headers["fifo-timestamp"] ?? "";
  const given = (headers["fifo-signature"] ?? "").replace(/^sha256=/, "");
  const expected = createHmac("sha256", secret)
    .update(`${timestamp}.${eventId}.${rawBody}`)
    .digest("hex");
  if (given.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(given, "hex"), Buffer.from(expected, "hex"));
}
```

### Events that wake the routine

Only the `dispatcher` destination is POSTed to `WEBHOOK_DISPATCH_URL`. Other destinations (personal-queue owners, `requester_ref`) are recorded in the outbox as `stubbed` for audit.

| `type` | When it fires | What the routine typically does |
|---|---|---|
| `item.enqueued` | New claimable work on `team:eng` | If a Factory seat is free, claim the head (`fifo next --team eng --assignee <ic>`, or `fifo claim-cr` for Code Review) |
| `item.assigned` | An item was claimed onto a seat | Wake the assignee (or a dedicated assigner) if that is how your fleet works |
| `item.stalled` | Factory in-progress went quiet past the stall clock | Chase the assignee |
| `item.done` | An item completed and `requester_ref` is set | Notify that requester when it is an agent id |
| `item.hard_blocked` / `item.hard_block_cleared` | Hard-block toggled on `team:eng` | Ops awareness; the seat stays held |
| `eng.hours.open` | Weekday open tick (06:00 America/Denver) | Drain queued heads while seats are free |

The Worker does **not** POST for parked-queue events, HOLD / STOP / parked titles, after-hours claimable noise, or move / reorder / progress / capacity chatter. Those still land in `item_events`. Empty `WEBHOOK_DISPATCH_URL` stubs every row.

Keep a dedupe store of CloudEvent `id`s so outbox retries do not double-claim.

### CLI from the Grok Bot host

On the dispatcher box (vaulted env, never print secrets):

```bash
export FIFO_API=https://fifo-api.<your-domain>
export FIFO_ACCESS_CLIENT_ID=…
export FIFO_ACCESS_CLIENT_SECRET=…
export FIFO_ACTOR=dispatcher
export FIFO_SPOOL=/tmp/fifo-spool   # optional; default ~/.fifo-spool

npm link   # or: node ./cli/fifo.mjs …
fifo enqueue --team eng --title "…" --json
fifo next --team eng --assignee <ic>
fifo progress --id <id> --note "…"
fifo done --id <id>
fifo queue show --team eng
```

Mutations are written to the spool directory first and deleted only after HTTP 2xx. Replays reuse the original `Idempotency-Key`.

## Local development

```bash
npm ci
npm test
npm run typecheck
npx wrangler d1 migrations apply fifo-worker --local
```

`wrangler.toml` defaults to production-shaped auth (`AUTH_REQUIRED = "true"`). For local smoke tests, put the following in `.dev.vars` (gitignored) and seed an `api_clients` row. Do not commit `.dev.vars`.

```bash
printf 'AUTH_REQUIRED=false\n' > .dev.vars
npx wrangler d1 execute fifo-worker --local --command \
  "INSERT OR IGNORE INTO api_clients (id, client_id, secret_hash, agent_id, permissions_json, name, created_at) VALUES ('local-dispatcher', 'dev-dispatcher', '', 'dispatcher', '[\"dispatcher\"]', 'Local dispatcher', datetime('now'))"
npx wrangler dev
```

On `localhost` / `127.0.0.1` with `AUTH_REQUIRED=false`, the Worker binds `CF-Access-Client-Id` (or `X-Fifo-Client`) to that row without checking a secret.

```bash
export FIFO_API=http://127.0.0.1:8787
curl -s "$FIFO_API/health"
# {"ok":true,"service":"fifo-worker"}

FIFO_ACCESS_CLIENT_ID=dev-dispatcher FIFO_ACTOR=dispatcher \
  node cli/fifo.mjs enqueue --team eng --title "Local smoke" --json
```

Without `WEBHOOK_DISPATCH_URL`, outbox rows are `stubbed`. Inspect them with:

```bash
npx wrangler d1 execute fifo-worker --local \
  --command "SELECT event_type, destination, status FROM webhook_outbox ORDER BY created_at"
```

## CLI

`cli/fifo.mjs` is the `fifo` bin (`npm link`, `npm i -g .`, or `node ./cli/fifo.mjs …`). Headless: no chat integrations.

| Variable | Purpose | Default |
|---|---|---|
| `FIFO_API` | Worker base URL | `http://127.0.0.1:8787` |
| `FIFO_ACCESS_CLIENT_ID` (or `CF_ACCESS_CLIENT_ID`) | Sent as `CF-Access-Client-Id` | — |
| `FIFO_ACCESS_CLIENT_SECRET` (or `CF_ACCESS_CLIENT_SECRET`) | Sent as `CF-Access-Client-Secret` | — |
| `FIFO_BEARER` | Sent as `Authorization: Bearer …` | — |
| `FIFO_ACTOR` | Sent as `X-Fifo-Actor` | — |
| `FIFO_SPOOL` | Write-ahead spool directory | `~/.fifo-spool` |

```text
fifo enqueue --personal <agent> --title <text>
fifo enqueue --team eng|parked --title <text> [--kind code_review|implement|ops]
fifo next --team eng --assignee <ic>
fifo claim-cr --team eng --assignee <ic>
fifo progress --id <id> [--note]
fifo done --id <id>
fifo block --id <id> [--reason]
fifo unblock --id <id>
fifo cancel --id <id>
fifo move --id <id> --team parked|eng
fifo queue show --team eng|parked | --personal <agent>
fifo share mint --queue team:eng|team:parked|personal:<agent>
fifo help
```

`--json` prints the raw response. Mutations need `Idempotency-Key` (the CLI generates one). The CLI never prints secrets.

## HTTP API

`GET /health` is public. Everything under `/v1/*` requires auth. Mutations require `Idempotency-Key`. Items are idempotent on `(source_system, source_ref)`. `queue_key` is `personal:<agent>`, `team:eng`, or `team:parked`.

| Method | Path |
|---|---|
| GET | `/health` |
| GET | `/v1/health` |
| POST | `/v1/items` |
| GET | `/v1/items/:id` |
| GET | `/v1/queues/:queue_key` |
| POST | `/v1/queues/:queue_key/claim-next` |
| POST | `/v1/queues/:queue_key/claim-cr` |
| POST | `/v1/queues/:queue_key/sync-in-progress` |
| POST | `/v1/items/:id/progress` |
| POST | `/v1/items/:id/comments` |
| POST | `/v1/items/:id/done` |
| POST | `/v1/items/:id/hard-block` |
| POST | `/v1/items/:id/clear-block` |
| POST | `/v1/items/:id/cancel` |
| POST | `/v1/items/:id/move` |
| POST | `/v1/items/:id/update` |
| POST | `/v1/items/:id/reorder` |
| POST | `/v1/share-tokens` |
| DELETE | `/v1/share-tokens/:token_id` |
| POST | `/v1/queues/:queue_key/rotate-share-generation` |
| GET | `/s/<token>` |

## Cron

`*/5 * * * *` — stall sweep, weekday `eng.hours.open` ping, webhook outbox retry.

## Configuration

These names match live `wrangler.toml`. Do not add extras.

### `[vars]` (committed)

| Var | Default | Purpose |
|---|---|---|
| `AUTH_REQUIRED` | `true` | Require Access JWT, service-token pair, or hashed bearer. Set `false` only in `.dev.vars` for localhost. |
| `CF_ACCESS_TEAM_DOMAIN` | placeholder | Access team domain (`https://<team>.cloudflareaccess.com`) — JWT issuer / JWKS |
| `FIFO_API_HOST` | placeholder | Hostname that serves `/v1/*` |
| `FIFO_SHARE_HOST` | placeholder | Hostname that serves `/s/*` |
| `SHARE_PUBLIC_ORIGIN` | placeholder | Public base URL for minted share links |
| `STALL_TZ` | `America/Denver` | Stall-clock timezone |
| `STALL_START_HOUR` | `8` | Stall window start (wall-clock hour) |
| `STALL_END_HOUR` | `17` | Stall window end (wall-clock hour, exclusive) |
| `STALL_BUSINESS_MINUTES` | `60` | Business minutes of silence before `item.stalled` |
| `ENG_CAPACITY` | `6` | `team:eng` Factory in-progress capacity |

### Secrets (`wrangler secret put` — never git)

| Secret | Purpose |
|---|---|
| `WEBHOOK_HMAC_SECRET` | HMAC key for `Fifo-Signature` |
| `WEBHOOK_DISPATCH_URL` | Dispatcher Grok Bot routine webhook URL (empty = stub) |
| `WEBHOOK_DISPATCH_AUTHORIZATION` | `Authorization` header sent with each webhook |
| `CF_ACCESS_AUD` | Access application audience |

Client secrets are not Wrangler config. Store only SHA-256 hex in `api_clients.secret_hash`.

## Layout

| Path | Role |
|---|---|
| `src/` | TypeScript Worker (`/v1/*`, `/s/<token>`, cron `*/5`) |
| `migrations/` | D1 migrations (schema + seed) |
| `schema.sql` | Read-only schema copy |
| `cli/fifo.mjs` | `fifo` CLI (spool + replay) |
| `test/` | FIFO invariants |
| `wrangler.toml` | Worker name, D1 binding, `[vars]`, cron |

## License

This project is MIT-licensed. See [LICENSE](./LICENSE).
