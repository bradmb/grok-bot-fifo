# grok-bot-fifo

Cloudflare Worker + D1 queue authority + `fifo` CLI for **Grok Bot** agent fleets.

Use this repo when you want a shared FIFO (first-in, first-out) work queue that
Grok Bot agents claim from, stall-chase, and complete — with webhooks that wake
agent **routines** on enqueue, assign, stall, and done.

- **Repo:** https://github.com/bradmb/grok-bot-fifo
- **License:** MIT
- **Secrets:** never commit tokens, Access credentials, or webhook Authorization headers

## What you get

- `personal:<agent>` queues — one in-progress seat per owner (WIP = 1); overflow stays queued with an optional share link
- `team:eng` — N named IC seats (`queue_slots`); `claim-next` fills Factory seats; `claim-cr` fills a parallel Code Review lane
- `team:parked` — hold lane (capacity 0, not claimable); items move eng ↔ parked
- Hard-block holds a seat; `clear-block` unblocks without releasing
- Stall clock on Factory in-progress (default business hours America/Denver)
- Share boards: `GET /s/<token>` — Queued | In Progress | Code Review (no secrets, live refresh)
- Webhook outbox (CloudEvents, HMAC-signed) → your Grok Bot routine URL

## Prerequisites

- Node 22+ and npm
- A Cloudflare account (Workers + D1)
- A Grok Bot agent that will own queue ops (the “dispatcher” / Lane role)
- Optional but recommended: Cloudflare Access service tokens for the API host

## Install and deploy (full path)

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
```

### 3. Create D1 and wire `wrangler.toml`

```bash
npx wrangler d1 create fifo-worker
```

Copy the returned `database_id` into `wrangler.toml` under `[[d1_databases]]`:

```toml
[[d1_databases]]
binding = "DB"
database_name = "fifo-worker"
database_id = "<from-wrangler-d1-create>"
migrations_dir = "migrations"
```

Set your Cloudflare `account_id` in `wrangler.toml` (from `wrangler whoami`).

Replace placeholder hostnames under `[vars]` (`CF_ACCESS_TEAM_DOMAIN`,
`FIFO_API_HOST`, `FIFO_SHARE_HOST`, `SHARE_PUBLIC_ORIGIN`) with your domain,
or keep `workers_dev = true` for a first deploy on `*.workers.dev`.

### 4. Apply migrations

Local:

```bash
npx wrangler d1 migrations apply fifo-worker --local
```

Remote (production D1):

```bash
npx wrangler d1 migrations apply fifo-worker --remote
```

### 5. Deploy the Worker

```bash
npx wrangler deploy
```

Note the Worker URL (e.g. `https://fifo-worker.<account>.workers.dev`). That
base URL is `FIFO_API` for the CLI and for agents.

### 6. Custom hosts + Cloudflare Access (recommended)

For a production split:

1. Create DNS for `fifo-api.<your-domain>` and `fifo-share.<your-domain>`.
2. Uncomment `routes` in `wrangler.toml` and set `workers_dev = false` once Access is live on the API host.
3. Create a Cloudflare Zero Trust **Access** application on `fifo-api.<your-domain>` (service-token policy for machines/agents).
4. Leave `fifo-share.<your-domain>` **without** Access — the share path `/s/<token>` is the bearer.
5. Put the Access application audience in secrets as `CF_ACCESS_AUD`.

### 7. Secrets (never commit)

```bash
npx wrangler secret put WEBHOOK_HMAC_SECRET
npx wrangler secret put WEBHOOK_DISPATCH_URL
npx wrangler secret put WEBHOOK_DISPATCH_AUTHORIZATION
npx wrangler secret put CF_ACCESS_AUD
```

| Secret | Purpose |
|---|---|
| `WEBHOOK_HMAC_SECRET` | HMAC key for signed CloudEvents bodies |
| `WEBHOOK_DISPATCH_URL` | **Grok Bot routine webhook URL** (see below). Empty = stub delivery (audit only) |
| `WEBHOOK_DISPATCH_AUTHORIZATION` | `Authorization` header value the Worker sends to that URL (often `Bearer …`) |
| `CF_ACCESS_AUD` | Access application audience for JWT verification on the API host |

### 8. API clients in D1

Clients authenticate with Cloudflare Access service tokens
(`CF-Access-Client-Id` / `CF-Access-Client-Secret`) or a per-client bearer
whose SHA-256 is stored in `secret_hash`.

```sql
INSERT INTO api_clients (id, client_id, secret_hash, agent_id, permissions_json, name, created_at)
VALUES (
  lower(hex(randomblob(16))),
  '<access-client-id-or-client-key>',
  '<sha256-hex of the secret>',
  'dispatcher',
  '["dispatcher"]',
  'Dispatcher / Lane Grok Bot',
  datetime('now')
);
```

Run via:

```bash
npx wrangler d1 execute fifo-worker --remote --command "<sql>"
```

Permissions:

- `dispatcher` — claim / cancel / move / sync / team share (Lane ops agent)
- `runner` — move eng↔parked, progress
- `team:eng:enqueue`, `team:parked:enqueue`, `team:eng:progress`, `personal:own`

Seed ICs / capacity with migrations + `ENG_CAPACITY` in `wrangler.toml` (default 6).

### 9. Smoke test

```bash
export FIFO_API=https://fifo-worker.<account>.workers.dev   # or your fifo-api host
curl -s "$FIFO_API/health"
# {"ok":true,"service":"fifo-worker"}
```

With Access / actor headers (values from your vault — do not paste secrets into chat):

```bash
curl -s "$FIFO_API/v1/queues/personal:dev1" \
  -H "CF-Access-Client-Id: $FIFO_ACCESS_CLIENT_ID" \
  -H "CF-Access-Client-Secret: $FIFO_ACCESS_CLIENT_SECRET" \
  -H "X-Fifo-Actor: dispatcher"
```

## Hook to a Grok Bot agent routine

The Worker does **not** chat. It POSTs signed CloudEvents to a URL you own.
Point that URL at a **Grok Bot routine webhook** on the agent that runs FIFO
ops (dispatcher / Lane).

### A. Create the routine on the Grok Bot

1. Open the dispatcher agent in Grok Bot.
2. Add a **webhook** routine (example name: `FIFO Worker Lane webhooks`).
3. Copy from the routine sidebar:
   - **Webhook URL** → this becomes `WEBHOOK_DISPATCH_URL`
   - **Webhook key / Authorization header** → this becomes `WEBHOOK_DISPATCH_AUTHORIZATION` (use the exact header value Grok Bot shows, usually `Bearer <key>`)
4. Routine prompt should:
   - Parse the CloudEvent (`type` + `data`)
   - **Silent-exit** on noise (capacity/move/progress, after-hours dark, already-handled event ids)
   - On `item.enqueued` with a free seat: ask your assigner agent to **name one IC**, then run `fifo next --team eng --assignee <name>` (or your CLI wrapper) — **do not** wake Eng ICs from Lane; the assigner wakes them after claim
   - On `item.stalled`: chase the assigner 1:1 (never skip to ICs)
   - On `item.done`: notify requester agents when `requester_ref` is an agent id; stay quiet for human-only requesters if that is your policy
   - On `item.assigned`: usually a **noop** for Lane (assigner owns IC wake)

Keep a dedupe store of event `id`s so retries do not double-claim.

### B. Wire secrets on the Worker

```bash
npx wrangler secret put WEBHOOK_DISPATCH_URL
# paste: https://…  (Grok Bot routine webhook URL)

npx wrangler secret put WEBHOOK_DISPATCH_AUTHORIZATION
# paste: Bearer …  (exact value from Grok Bot)

npx wrangler secret put WEBHOOK_HMAC_SECRET
# long random string; store the same value if your routine verifies HMAC
```

### C. Event types the dispatcher receives

CloudEvents envelope (`specversion: 1.0`, `source: fifo-worker`):

| `type` | When Lane usually acts |
|---|---|
| `item.enqueued` | Free seat + claimable `team:eng` head → ask assigner for IC name, then claim-next |
| `item.assigned` | Usually noop (assigner wakes IC) |
| `item.stalled` | Stall chase → assigner 1:1 |
| `item.hard_blocked` / `item.hard_block_cleared` | Ops / assigner awareness |
| `item.done` | Close loops to `requester_ref` agents when set |
| `eng.hours.open` | Morning drain / reopen claim path |

Delivery is filtered: parked queues, HOLD/STOP titles, after-hours claimable noise, and move/reorder/capacity chatter do **not** wake the dispatcher webhook. Empty `WEBHOOK_DISPATCH_URL` stubs delivery (DB audit only).

### D. HMAC verification (recommended)

Each POST is signed. Verify with `WEBHOOK_HMAC_SECRET` over:

```text
{timestamp}.{eventId}.{rawBody}
```

Reject mismatched signatures before mutating state.

### E. CLI from the Grok Bot box

On the dispatcher agent host (or any runner with vaulted env):

```bash
export FIFO_API=https://fifo-api.<your-domain>
export FIFO_ACCESS_CLIENT_ID=…
export FIFO_ACCESS_CLIENT_SECRET=…
export FIFO_ACTOR=dispatcher
export FIFO_SPOOL=/tmp/fifo-spool   # optional

npm link   # or: node ./cli/fifo.mjs …
fifo enqueue --team eng --title "…" --json
fifo next --team eng --assignee <ic>
fifo progress --id <id> --note "…"
fifo done --id <id>
fifo queue show --team eng
```

Mutations spool to disk first and delete only after HTTP 2xx. The CLI never prints secrets.

### F. Pair with the FIFO Ops Grok Bot template

Import the **FIFO Ops** Grok Bot template, deploy this Worker first, then paste
`FIFO_API` + Access client credentials into the bot’s vault and set the
routine webhook secrets as in steps A–B. The template’s getting-started skill
walks those prompts one at a time.

## Local development

```bash
npm ci
npm test
npm run typecheck
npx wrangler d1 migrations apply fifo-worker --local
npx wrangler dev
```

`wrangler.toml` defaults to production-shaped auth. For local smoke tests, put
`AUTH_REQUIRED=false` (or the project’s local auth flag) in `.dev.vars`
(gitignored) and use a seeded `api_clients` row. Do not commit `.dev.vars`.

```bash
curl -s http://127.0.0.1:8787/health
```

## Layout

| Path | Role |
|---|---|
| `src/` | TypeScript Worker (`/v1/*`, `/s/<token>`, cron `*/5`) |
| `migrations/` | D1 migrations (schema + seed) |
| `schema.sql` | Read-only schema copy |
| `cli/fifo.mjs` | `fifo` CLI (spool + replay) |
| `test/` | FIFO invariants |

## API (`/v1/*`)

| Method | Path |
|---|---|
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

`queue_key` is `personal:<agent>`, `team:eng`, or `team:parked`. Mutations need
`Idempotency-Key`. Items are idempotent on `(source_system, source_ref)`.

## Cron

`*/5 * * * *` — stall sweep, `eng.hours.open` (weekday open in business TZ),
webhook outbox retry.

## Configuration (`[vars]`)

| Var | Default | Purpose |
|---|---|---|
| `AUTH_REQUIRED` | `true` | require Access/bearer auth |
| `CF_ACCESS_TEAM_DOMAIN` | — | Access team domain |
| `FIFO_API_HOST` / `FIFO_SHARE_HOST` | — | host split for `/v1/*` vs `/s/*` |
| `SHARE_PUBLIC_ORIGIN` | — | public base for share links |
| `STALL_TZ` / start / end / minutes | Denver / 8–17 / 60 | Factory stall window |
| `ENG_CAPACITY` | `6` | team:eng in-progress capacity |

## License

MIT © 2026 Brad Butner. See [LICENSE](./LICENSE).
